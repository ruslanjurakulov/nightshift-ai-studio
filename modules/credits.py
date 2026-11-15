"""Prepaid credits — what a finished run is charged (migration 0020).

A run for an organization other than the operator's own is paid for in
credits. The Command Center reserves an estimate before it dispatches the run
(``reserve_credits``, through the signed-in user's client); whoever runs it —
the VPS worker (``tools/queue_worker.py``) or the Actions workflow
(``tools/credits_settle.py``) — claims that hold before spending anything and
settles it when the run ends: ``capture_credits`` at what the run consumed on
success, ``release_credits`` on failure.

What "consumed" means is the cost ledger (``modules/cost_ledger.py``), held to
the ledger's own rule: **a number exists only when every entry behind it was
priced.** So a settlement is exactly one of:

* ``metered``  — every ledger entry of the run had a credit price; charge the
  sum (rounded up to the cent), never more than the hold;
* ``capped``   — the metered sum came to more than the hold; charge the hold
  (a capture never exceeds its reservation);
* ``unpriced`` — some entry had no credit price; charge the hold. The priced
  part would only be a floor, and charging a floor is undercharging silently;
* ``no_ledger`` — the run recorded nothing (the ledger write failed, or the
  run stopped before it); charge the hold, for the same reason. Unknown is not
  zero.

The prices come from the same database as the capture. When ``credit_prices``
cannot be read at settlement (3 tries, backing off) the whole run is planned as
``unpriced``: no entry can be priced, so the hold is charged in full rather
than a guess. That is decided once, together with the rest of the plan, and a
capture that then cannot be sent is kept with THAT amount (the worker's pending
marker replays the decision, it never re-reads prices), so a customer can be
charged the full hold for a run that metered less when the database was down at
the end of it. The alternatives are worse: a guess undercharges silently, and
releasing a delivered video's hold hands it out for free.

A failed run is released in full: the platform, not the customer, pays for a
run that produced nothing.

Prices (``credit_prices``) — credits = quantity x credits_per_unit x (1+margin):

* a ledger unit's own row (``tts_characters`` …) prices that unit by quantity;
* otherwise the ``usd`` row prices the entry's ``estimated_usd`` — which exists
  only when the operator set ``CHRONOS_PRICE_<UNIT>`` for it;
* otherwise the entry is unpriced.
* ``video_minute`` prices a run up front (the Command Center's estimate), and
  ``job_minimum`` is the smallest hold any run may take;
* a concept-thumbnail channel's hold also carries its generated images at the
  ``image_generations`` price, and the runner's floor checks them too
  (``minimum_reservation``).

The TypeScript twin of the pricing rules is ``command-center/lib/credits.ts``;
keep the two in step.
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Mapping, Optional, Tuple

logger = logging.getLogger(__name__)

UNIT_VIDEO_MINUTE = "video_minute"
UNIT_USD = "usd"
UNIT_JOB_MINIMUM = "job_minimum"
#: Rows of credit_prices that are not ledger units.
SPECIAL_UNITS = (UNIT_VIDEO_MINUTE, UNIT_USD, UNIT_JOB_MINIMUM)

#: The organization every pre-0018 channel lives in (migration 0018). Exempt.
DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001"

ENFORCE_ENV = "NIGHTSHIFT_CREDITS_ENFORCE"

SETTLE_METERED = "metered"
SETTLE_CAPPED = "capped"
SETTLE_UNPRICED = "unpriced"
SETTLE_NO_LEDGER = "no_ledger"


def enforcement_enabled(env: Mapping[str, str]) -> bool:
    """``NIGHTSHIFT_CREDITS_ENFORCE`` — off unless explicitly on."""
    return str(env.get(ENFORCE_ENV, "") or "").strip().lower() in ("1", "true", "yes", "on")


def is_exempt(org_id: Optional[str]) -> bool:
    return str(org_id or "") == DEFAULT_ORG_ID


def round_up(credits: float) -> float:
    """To the cent, upward — the database rounds holds and charges the same way."""
    return math.ceil(round(float(credits) * 100, 6)) / 100


@dataclass(frozen=True)
class Price:
    credits_per_unit: float
    margin: float = 0.0

    def charge(self, quantity: float) -> float:
        return float(quantity) * self.credits_per_unit * (1.0 + self.margin)


def _num(v) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def parse_prices(rows: Optional[Iterable[Mapping]]) -> Dict[str, Price]:
    """credit_prices rows -> {unit: Price}. A row with a missing or negative
    rate is dropped (that unit is then unpriced), never read as 0."""
    out: Dict[str, Price] = {}
    for row in rows or []:
        try:
            unit = str(row.get("unit") or "").strip()
        except AttributeError:
            continue
        rate = _num(row.get("credits_per_unit"))
        margin = _num(row.get("margin"))
        if not unit or rate is None or rate < 0:
            continue
        out[unit] = Price(rate, margin if margin is not None and margin >= 0 else 0.0)
    return out


def entry_credits(entry: Mapping, prices: Mapping[str, Price]) -> Optional[float]:
    """Credits for one ledger entry, or None when it cannot be priced."""
    unit = str(entry.get("unit") or "")
    qty = _num(entry.get("quantity"))
    if qty is None:
        return None
    if unit and unit not in SPECIAL_UNITS and unit in prices:
        return prices[unit].charge(qty)
    usd = _num(entry.get("estimated_usd"))
    if usd is not None and UNIT_USD in prices:
        return prices[UNIT_USD].charge(usd)
    return None


@dataclass(frozen=True)
class Settlement:
    amount: float
    reason: str
    metered: Optional[float] = None
    unpriced_units: Tuple[str, ...] = field(default_factory=tuple)

    def describe(self) -> str:
        base = f"{self.amount:.2f} credits ({self.reason}"
        if self.metered is not None:
            base += f", metered {self.metered:.2f}"
        if self.unpriced_units:
            base += ", unpriced: " + ", ".join(self.unpriced_units)
        return base + ")"


def settle_amount(reserved: float, entries: Iterable[Mapping],
                  prices: Mapping[str, Price]) -> Settlement:
    """What to capture for a run that succeeded. Never more than ``reserved``;
    never less than it unless every entry was priced."""
    reserved = round_up(max(0.0, float(reserved)))
    entries = list(entries or [])
    if not entries:
        return Settlement(reserved, SETTLE_NO_LEDGER)
    total = 0.0
    unpriced = set()
    for e in entries:
        c = entry_credits(e, prices)
        if c is None:
            unpriced.add(str(e.get("unit") or "?"))
        else:
            total += c
    if unpriced:
        return Settlement(reserved, SETTLE_UNPRICED, None, tuple(sorted(unpriced)))
    metered = round_up(total)
    if metered > reserved:
        return Settlement(reserved, SETTLE_CAPPED, metered)
    return Settlement(metered, SETTLE_METERED, metered)


#: The ledger unit a generated image is recorded under (modules/cost_ledger.py IMAGE_GENERATIONS).
UNIT_IMAGE_GENERATIONS = "image_generations"
#: The most images a concept-thumbnail run generates: one per A/B arm, and the
#: run clamps the arms to 2..4 (config.THUMBNAIL_VARIANT_COUNT). The Command
#: Center's hold takes this ceiling (lib/credits.ts CONCEPT_THUMBNAIL_MAX_IMAGES)
#: because it cannot see the worker's setting; the floor takes the same ceiling,
#: so a hold the Command Center made is never refused here.
CONCEPT_THUMBNAIL_MAX_IMAGES = 4


def concept_thumbnail_on(agent_config) -> bool:
    """Whether a channel's ``agent_config`` turns concept thumbnails on — read
    like modules/thumbnail_concept.normalize_mode and lib/credits.ts
    conceptThumbnailOn: only the text "concept" (case and surrounding white
    space ignored). Not imported from thumbnail_concept, which loads config."""
    if not isinstance(agent_config, Mapping):
        return False
    mode = agent_config.get("thumbnail_mode")
    return isinstance(mode, str) and mode.strip().lower() == "concept"


def minimum_reservation(prices: Mapping[str, Price], duration_s=None,
                        agent_config: Optional[Mapping] = None) -> Optional[float]:
    """The smallest complete hold: the job minimum or the priced duration,
    whichever is greater. Missing/invalid duration or base pricing is refused.

    A concept-thumbnail channel (``agent_config``) also buys up to
    CONCEPT_THUMBNAIL_MAX_IMAGES generated images, on the worker's own keys, on
    top of that — the Command Center holds them the same way (withConceptThumbnail).
    Without this, a browser that called reserve_credits directly could file the
    job against the bare floor, and settle_amount caps the capture at the hold:
    the images would be paid by the platform. When ``image_generations`` has no
    price there is no honest floor (the Command Center cannot make a hold either),
    so this raises CreditRefused naming the fix, rather than leaving them out."""
    minute = prices.get(UNIT_VIDEO_MINUTE)
    if minute is None or not math.isfinite(minute.credits_per_unit) or minute.credits_per_unit <= 0:
        raise CreditRefused("video_minute has no valid positive base price — configure video pricing before starting a paid run")
    floors: List[float] = []
    if UNIT_JOB_MINIMUM in prices:
        floors.append(prices[UNIT_JOB_MINIMUM].credits_per_unit)
    d = _num(duration_s)
    if d is None or d <= 0:
        raise CreditRefused("a paid run needs its priced duration — choose a length and start it again")
    floors.append(minute.charge(d / 60.0))
    base = round_up(max(floors)) if floors else None
    if not concept_thumbnail_on(agent_config):
        return base
    image = prices.get(UNIT_IMAGE_GENERATIONS)
    if image is None:
        raise CreditRefused(
            "this channel makes concept thumbnails, and generated images (image_generations) have no "
            "credit price, so no hold can cover them — add an image_generations row to credit_prices, "
            "or set the channel's thumbnails back to frame mode")
    # Rounded like the Command Center's hold: the floor first, then floor + images.
    return round_up((base or 0.0) + image.charge(CONCEPT_THUMBNAIL_MAX_IMAGES))


def _ts(value) -> Optional[datetime]:
    if not value:
        return None
    try:
        t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def run_entries(rows: Iterable[Mapping], channel_id: str, since) -> List[dict]:
    """The ledger rows this run wrote: this channel's, recorded at or after the
    run started. One running job per channel (0017) keeps that unambiguous on
    a worker; an entry with an unreadable timestamp is left out rather than
    guessed into or out of a charge."""
    start = _ts(since)
    out = []
    for r in rows or []:
        if str(r.get("channel_id") or "") != str(channel_id):
            continue
        t = _ts(r.get("recorded_at"))
        if t is None or (start is not None and t < start):
            continue
        out.append(dict(r))
    return out


def local_run_entries(channel_id: str, since) -> List[dict]:
    """This machine's ledger (history/chronos.db, where main.py writes it) for
    one run. Raises when the store cannot be read — the caller then charges the
    hold instead of guessing."""
    from modules.state_store import StateStore  # noqa: PLC0415 — imports config

    with StateStore() as store:
        rows = store.list_video_costs(channel_id=channel_id, limit=100000)
    return run_entries(rows, channel_id, since)


# ── the service-key client ──────────────────────────────────────────────────

class CreditsUnavailable(RuntimeError):
    """The credit functions could not be reached (network, HTTP error, or
    migration 0020 not applied). Never carries a key or a response body."""


class CreditsRest:
    """The 0020 functions over PostgREST with the service key. Used by the
    worker and by the workflow's settle step — never by the Command Center,
    which does not hold the service key. Failures are logged with the HTTP
    status only."""

    def __init__(self, url: str, service_key: str, *, timeout: float = 15.0, session=None):
        import requests  # noqa: PLC0415 — keep imports light for the tests

        self.url = url.rstrip("/")
        self._key = service_key
        self._timeout = timeout
        self._http = session or requests.Session()

    def _headers(self) -> dict:
        return {"apikey": self._key, "Authorization": f"Bearer {self._key}",
                "Content-Type": "application/json"}

    def _rpc(self, name: str, body: dict):
        try:
            r = self._http.post(f"{self.url}/rest/v1/rpc/{name}", json=body,
                                headers=self._headers(), timeout=self._timeout)
        except Exception as e:
            raise CreditsUnavailable(f"{name}: {type(e).__name__}") from None
        if r.status_code >= 300:
            raise CreditsUnavailable(f"{name}: HTTP {r.status_code} (is migration 0020 applied?)")
        try:
            return r.json()
        except ValueError:
            return None

    def _get(self, table: str, params: dict) -> list:
        try:
            r = self._http.get(f"{self.url}/rest/v1/{table}", params=params,
                               headers=self._headers(), timeout=self._timeout)
        except Exception as e:
            raise CreditsUnavailable(f"{table}: {type(e).__name__}") from None
        if r.status_code >= 300:
            raise CreditsUnavailable(f"{table}: HTTP {r.status_code}")
        try:
            rows = r.json()
        except ValueError:
            # A 2xx that is not JSON (a proxy's error page) is not "no rows": it
            # would read as no settings, or no organization.
            raise CreditsUnavailable(f"{table}: the reply was not JSON") from None
        return rows if isinstance(rows, list) else []

    def prices(self) -> Dict[str, Price]:
        return parse_prices(self._get("credit_prices", {"select": "unit,credits_per_unit,margin"}))

    def channel_org(self, channel_id: str) -> Optional[str]:
        rows = self._get("channels", {"select": "org_id", "channel_id": f"eq.{channel_id}"})
        return str(rows[0].get("org_id") or "") or None if rows else None

    def channel_agent_config(self, channel_id: str) -> dict:
        """The channel's ``agent_config`` — the same column the run reads its
        settings from (ChannelRegistry) and the Command Center prices its hold
        from. A null column is ``{}`` (the run reads defaults from it too). No
        row is not "no settings": it raises, and the run is refused."""
        rows = self._get("channels", {"select": "agent_config", "channel_id": f"eq.{channel_id}"})
        if not rows:
            raise CreditsUnavailable("channels: no row for this channel's settings")
        cfg = rows[0].get("agent_config")
        return dict(cfg) if isinstance(cfg, dict) else {}

    def start(self, job_ref: str, org_id: str) -> Optional[float]:
        return _num(self._rpc("start_credit_reservation", {"p_job_id": job_ref, "p_org": org_id}))

    def capture(self, job_ref: str, amount: float) -> Optional[float]:
        return _num(self._rpc("capture_credits",
                              {"p_job_id": job_ref, "p_actual": round_up(amount), "p_allow_over": False}))

    def release(self, job_ref: str) -> Optional[float]:
        return _num(self._rpc("release_credits", {"p_job_id": job_ref}))

    def reservation(self, job_ref: str) -> Optional[dict]:
        """The reservation's ``status`` / ``captured`` (a read; None when there is none)."""
        rows = self._get("credit_reservations", {"select": "status,captured", "job_id": f"eq.{job_ref}"})
        return dict(rows[0]) if rows else None

    def expire(self) -> Optional[float]:
        return _num(self._rpc("expire_credit_reservations", {}))

    def expire_lots(self) -> Optional[float]:
        """Migration 0034: credits of lots past their expiry (a subscription
        period that ended, a pack older than its validity) leave the balance.
        Returns the credits expired."""
        return _num(self._rpc("expire_credit_lots", {}))

    # Migration 0076: a scene regeneration's hold is claimed and settled by
    # the database, with its status, in one transaction each.
    def scene_regen_start(self, regen_id: str, job_id) -> Optional[dict]:
        out = self._rpc("start_scene_regeneration", {"p_id": regen_id, "p_job": int(job_id)})
        return out if isinstance(out, dict) else None

    def scene_regen_finish(self, regen_id: str, job_id, *, ok: bool, error_code: Optional[str] = None,
                           error: Optional[str] = None, result: Optional[dict] = None) -> Optional[dict]:
        out = self._rpc("finish_scene_regeneration", {
            "p_id": regen_id, "p_job": int(job_id), "p_ok": bool(ok), "p_error_code": error_code,
            "p_error": (error or None) and str(error)[:500], "p_result": result})
        return out if isinstance(out, dict) else None

    def scene_regen_expire(self) -> Optional[float]:
        return _num(self._rpc("expire_scene_regenerations", {}))

    def scene_regen_unsettled(self) -> List[dict]:
        """Migration 0085: the regenerations the expiry sweep is about to
        release (id, render_job_id, slug, status, created_at)."""
        out = self._rpc("scene_regenerations_unsettled", {})
        return [dict(r) for r in out if isinstance(r, dict)] if isinstance(out, list) else []

    def api_hold_start(self, hold_ref: str, job_id) -> Optional[float]:
        """Migration 0031: the API balance hold's amount (cents) when it is open
        and bound to exactly this job, else None."""
        return _num(self._rpc("api_hold_start", {"p_ref": hold_ref, "p_job_id": int(job_id)}))

    def api_hold_start_priced(self, hold_ref: str, job_id):
        return self._rpc("api_hold_start_priced", {"p_ref": hold_ref, "p_job_id": int(job_id)})


def open_api_hold(client, *, hold_ref: str, job_id) -> str:
    """A job created through the public API (migration 0031) is paid from the
    organization's API balance, not credits: the database holds it at create
    and settles it itself when the job ends (a trigger on render_jobs). The
    runner's part is to refuse the job unless the checked claim validates its
    pricing, expiry and binding. Returns the frozen mode, never a site-credit
    Hold to settle; a browser-supplied payer column alone proves nothing."""
    if client is None:
        raise CreditRefused("this job is paid from the API balance, but this worker has no "
                            "credits client to check the hold")
    try:
        terms = client.api_hold_start_priced(hold_ref, job_id)
    except CreditsUnavailable as e:
        raise CreditRefused(f"the API balance is unavailable ({e})") from None
    amount = _num(terms.get("amount_cents")) if isinstance(terms, Mapping) else None
    if amount is None or amount <= 0 or terms.get("thumbnail_mode") not in ("frame", "concept"):
        raise CreditRefused("its API balance hold is not open or does not cover the current priced thumbnail terms — create it again")
    return terms["thumbnail_mode"]


# ── the two ends of a paid run ──────────────────────────────────────────────

@dataclass(frozen=True)
class Hold:
    """A started reservation this run must settle."""
    job_ref: str
    org_id: str
    amount: float
    #: The thumbnail mode the floor was checked against ("concept" | "frame"),
    #: or None when no floor was checked. The run is handed it
    #: (HELD_THUMBNAIL_MODE_ENV) and refuses a mode the hold did not cover.
    thumbnail_mode: Optional[str] = None


#: How the runner tells main.py which thumbnail mode the hold was checked for.
#: The run reads the channel's settings itself, later, from its own registry
#: load; between the two an organization administrator (0158) could switch
#: concept thumbnails on and have a frame-priced hold pay for 4 images.
HELD_THUMBNAIL_MODE_ENV = "NIGHTSHIFT_HELD_THUMBNAIL_MODE"
HELD_FRAME = "frame"
HELD_CONCEPT = "concept"


class HeldTermsRefused(RuntimeError):
    """The run's settings are not the ones its hold was checked for. Raised by
    main.py before anything is spent; the runner releases the hold."""


def held_thumbnail_refusal(env: Mapping[str, str], run_mode_is_concept: bool) -> Optional[str]:
    """Why the run must stop before spending, or None. Only a run whose hold
    was checked carries the variable (the operator's exempt runs do not);
    mode changes in either direction require a new run/quote."""
    held = str(env.get(HELD_THUMBNAIL_MODE_ENV, "") or "").strip().lower()
    if not held or held == (HELD_CONCEPT if run_mode_is_concept else HELD_FRAME):
        return None
    if held == HELD_CONCEPT:
        return "thumbnail mode changed after this run's credits were checked — nothing was spent; start the run again from the Command Center"
    return ("concept thumbnails were turned on after this run's credits were checked, and its hold does not "
            f"cover the up to {CONCEPT_THUMBNAIL_MAX_IMAGES} generated images — nothing was spent; start the run "
            "again from the Command Center")


class CreditRefused(Exception):
    """The run must not start: the reason is safe to store and show."""


def open_hold(client, *, job_ref: Optional[str], channel_id: str,
              duration_s=None, enforce: bool) -> Optional[Hold]:
    """Before a run spends anything: find this channel's organization and claim
    the run's hold. Returns the Hold to settle at the end, or None when there
    is nothing to settle (exempt org, or not enforced and no hold).

    With ``enforce`` a run of a non-exempt organization needs an open hold of
    at least ``minimum_reservation`` for its length and its channel's
    ``agent_config`` — a browser can call reserve_credits directly and file a
    job against a token hold, so the runner checks too.
    Raises CreditRefused (nothing was run) or, when enforcing, turns an
    unreachable credits API into a refusal: an unpaid run is not a fallback."""
    ref = (job_ref or "").strip() or None
    if not enforce and not ref:
        return None
    try:
        org = client.channel_org(channel_id)
        if is_exempt(org):
            return None
        if org is None:
            if enforce:
                raise CreditRefused(f"channel {channel_id} has no organization on record")
            return None
        if not ref:
            raise CreditRefused("no credit reservation for this run — start it from the Command Center")
        floor = _Floor.read(client, channel_id, duration_s) if enforce else None
        amount = client.start(ref, org)
        if amount is None:
            if enforce:
                raise CreditRefused("its credit reservation is not open (expired, settled, or "
                                    "for another organization)")
            return None
        if floor is None:
            return Hold(ref, org, float(amount))
        floor.check(client, ref, amount, "this run requires")
        return Hold(ref, org, float(amount), floor.held_mode)
    except CreditsUnavailable as e:
        if enforce:
            raise CreditRefused(f"credits are unavailable ({e})") from None
        logger.warning("credits: %s — run continues unsettled (enforcement is off)", e)
        return None


@dataclass(frozen=True)
class _Floor:
    """The smallest hold a run may carry, decided BEFORE the hold is claimed.

    Every read it needs (the channel's settings, the prices) happens first, so
    once the hold is claimed nothing is left that can fail and strand it until
    the expiry sweep. A refusal found after the claim gives the hold back at
    once."""
    minimum: Optional[float]
    refusal: Optional[CreditRefused]
    concept: bool

    @property
    def held_mode(self) -> str:
        return HELD_CONCEPT if self.concept else HELD_FRAME

    @staticmethod
    def read(client, channel_id: str, duration_s) -> "_Floor":
        agent_config = client.channel_agent_config(channel_id)
        prices = client.prices()
        concept = concept_thumbnail_on(agent_config)
        try:
            return _Floor(minimum_reservation(prices, duration_s, agent_config), None, concept)
        except CreditRefused as e:
            return _Floor(None, e, concept)

    def check(self, client, ref: str, amount: float, requires: str) -> None:
        if self.refusal is not None:
            _safe(client.release, ref)
            raise self.refusal
        if self.minimum is not None and amount + 1e-9 < self.minimum:
            _safe(client.release, ref)
            why = (f"its reservation of {amount:.2f} credits is below the {self.minimum:.2f} {requires}")
            if self.concept:
                # Rule 6: the honest case is a hold priced before concept
                # thumbnails were switched on — say so, and what to do.
                why += (f", which includes up to {CONCEPT_THUMBNAIL_MAX_IMAGES} generated concept-thumbnail "
                        "images; if concept thumbnails were turned on after this run was priced, start it "
                        "again from the Command Center")
            raise CreditRefused(why)


def frozen_duration(params: Optional[Mapping]) -> Optional[int]:
    """The length a queued job was priced and frozen at (migration 0041 writes
    ``params.duration`` when a customer's job is queued), or None."""
    d = _num((params or {}).get("duration"))
    return int(d) if d is not None and d > 0 else None


def open_queue_hold(client, *, job_ref: Optional[str], channel_id: str,
                    params: Optional[Mapping]) -> Optional[Hold]:
    """The queue worker's check before a run spends anything. Returns the Hold
    to settle at the end, or None for the operator's own (exempt) organization.

    Unlike :func:`open_hold` (the Actions settle step), paying does not depend
    on ``NIGHTSHIFT_CREDITS_ENFORCE``: with the flag off a customer's job used
    to run for free, and the rule "only the operator may start an unpaid run"
    lived only in the web route (review finding C2). So, for any other
    organization, always:

    * the job carries a credit hold, and it is open for this organization;
    * the job carries its FROZEN length — ``params.duration``, written when it
      was queued — and the run uses exactly that (C1: the hold priced one
      length, and a run without one read the channel's target at run time);
    * the hold covers that length and the channel's generated add-ons
      (``minimum_reservation``: concept thumbnails, read from the channel's
      ``agent_config``).

    Anything the worker cannot check — no credits client, no organization on
    record, the credits API unreachable — is a refusal: an unpaid run is not a
    fallback. Raises CreditRefused; nothing has been run."""
    if client is None:
        raise CreditRefused("this worker has no credits client, so it cannot tell who pays for this run")
    ref = (job_ref or "").strip() or None
    try:
        org = client.channel_org(channel_id)
        if is_exempt(org):
            return None
        if org is None:
            raise CreditRefused(f"channel {channel_id} has no organization on record")
        if not ref:
            raise CreditRefused("no credit reservation for this run — start it from the Command Center")
        duration = frozen_duration(params)
        if duration is None:
            raise CreditRefused("its length was not fixed when it was queued (no duration) — queue it again")
        floor = _Floor.read(client, channel_id, duration)
        amount = client.start(ref, org)
        if amount is None:
            raise CreditRefused("its credit reservation is not open (expired, settled, or for another "
                                "organization)")
        floor.check(client, ref, amount, f"a {duration}-second run requires")
        return Hold(ref, org, float(amount), floor.held_mode)
    except CreditsUnavailable as e:
        raise CreditRefused(f"credits are unavailable ({e})") from None


#: A settlement is a few RPCs to Supabase; one blip must not leave a hold open
#: (the 24 h expiry would then RELEASE it: a delivered video for free, or a
#: failed run's credits locked for a day).
SETTLE_TRIES = 3
SETTLE_BACKOFF_SECONDS = 2.0


def _with_backoff(fn, *args, sleep=time.sleep):
    """Call ``fn`` up to SETTLE_TRIES times, backing off between tries, while
    the credits API is unavailable. The last CreditsUnavailable is re-raised.
    Safe to repeat: capture/release on a hold that is no longer open return its
    recorded outcome and move no credits (migration 0020)."""
    for attempt in range(SETTLE_TRIES):
        try:
            return fn(*args)
        except CreditsUnavailable:
            if attempt + 1 >= SETTLE_TRIES:
                raise
            sleep(SETTLE_BACKOFF_SECONDS * (attempt + 1))


@dataclass(frozen=True)
class SettlePlan:
    """What a run's hold is settled with, decided ONCE: a capture carries the
    amount, so a retry (the queue worker's pending-settlement marker) replays
    exactly this number and never recomputes it from a ledger that, by then,
    also holds other jobs' costs."""
    action: str                 # "capture" | "release"
    amount: float = 0.0         # credits to capture (0 for a release)
    detail: str = ""            # what the amount is made of, for the log


def plan_settlement(client, hold: Hold, *, succeeded: bool, channel_id: str, since,
                    ledger=local_run_entries, sleep=time.sleep) -> SettlePlan:
    """Decide the settlement: a release on failure, else the metered cost of the
    run (see the module docstring) read from the ledger. Reads the ledger and the
    prices; touches no credits."""
    if not succeeded:
        return SettlePlan("release")
    try:
        entries = ledger(channel_id, since)
    except Exception as e:
        logger.warning("credits: could not read the run's ledger (%s) — charging the hold",
                       type(e).__name__)
        entries = []
    try:
        prices = _with_backoff(client.prices, sleep=sleep)
    except CreditsUnavailable as e:
        logger.warning("credits: prices unavailable (%s) — every entry counts as unpriced, so the whole "
                       "hold of %.2f credits is the charge", e, hold.amount)
        prices = {}
    s = settle_amount(hold.amount, entries, prices)
    return SettlePlan("capture", float(s.amount), s.describe())


def apply_settlement(client, hold: Hold, plan: SettlePlan, *, sleep=time.sleep) -> Optional[str]:
    """Carry out ``plan`` (3 tries, backing off). Returns a one-line description,
    or None when the credits API could not be reached (the hold stays open). A
    capture that comes back as 0 although a charge was asked for means the
    reservation was already settled without one (expired and released) — logged
    as an error and reported, since asking again would say the same."""
    try:
        if plan.action == "release":
            released = _with_backoff(client.release, hold.job_ref, sleep=sleep)
            return f"released {float(released or 0):.2f} credits (run did not complete)"
        got = _with_backoff(client.capture, hold.job_ref, plan.amount, sleep=sleep)
        if plan.amount > 0 and got is not None and float(got) == 0:
            logger.error("credits: capture of %.2f credits for reservation %s took effect as 0 — it was "
                         "already settled without a charge (expired?); check it by hand",
                         plan.amount, hold.job_ref)
            return f"NOT captured: reservation {hold.job_ref} was already settled without a charge"
        return "captured " + plan.detail
    except CreditsUnavailable as e:
        logger.error("credits: could not settle reservation %s (%s) — it stays open until it "
                     "is retried or expires; settle it by hand if this persists", hold.job_ref, e)
        return None


def settle_hold(client, hold: Hold, *, succeeded: bool, channel_id: str, since,
                ledger=local_run_entries, sleep=time.sleep) -> Optional[str]:
    """After the run: capture on success, release on failure. Returns a one-line
    description of what happened, or None when the credits API could not be
    reached after SETTLE_TRIES tries (the hold then stays open; logged as an
    error)."""
    plan = plan_settlement(client, hold, succeeded=succeeded, channel_id=channel_id, since=since,
                           ledger=ledger, sleep=sleep)
    return apply_settlement(client, hold, plan, sleep=sleep)


def _safe(fn, *args):
    try:
        return fn(*args)
    except CreditsUnavailable as e:
        logger.warning("credits: %s", e)
        return None
