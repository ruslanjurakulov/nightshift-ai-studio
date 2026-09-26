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

A failed run is released in full: the platform, not the customer, pays for a
run that produced nothing.

Prices (``credit_prices``) — credits = quantity x credits_per_unit x (1+margin):

* a ledger unit's own row (``tts_characters`` …) prices that unit by quantity;
* otherwise the ``usd`` row prices the entry's ``estimated_usd`` — which exists
  only when the operator set ``CHRONOS_PRICE_<UNIT>`` for it;
* otherwise the entry is unpriced.
* ``video_minute`` prices a run up front (the Command Center's estimate), and
  ``job_minimum`` is the smallest hold any run may take.

The TypeScript twin of the pricing rules is ``command-center/lib/credits.ts``;
keep the two in step.
"""

from __future__ import annotations

import logging
import math
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


def minimum_reservation(prices: Mapping[str, Price], duration_s=None) -> Optional[float]:
    """The smallest hold a run may carry: the ``job_minimum`` floor, and — when
    the run asks for a length and minutes are priced — that length's price.
    None when neither is known (nothing to check against)."""
    floors: List[float] = []
    if UNIT_JOB_MINIMUM in prices:
        floors.append(prices[UNIT_JOB_MINIMUM].credits_per_unit)
    d = _num(duration_s)
    if d is not None and d > 0 and UNIT_VIDEO_MINUTE in prices:
        floors.append(prices[UNIT_VIDEO_MINUTE].charge(d / 60.0))
    return round_up(max(floors)) if floors else None


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
        rows = r.json()
        return rows if isinstance(rows, list) else []

    def prices(self) -> Dict[str, Price]:
        return parse_prices(self._get("credit_prices", {"select": "unit,credits_per_unit,margin"}))

    def channel_org(self, channel_id: str) -> Optional[str]:
        rows = self._get("channels", {"select": "org_id", "channel_id": f"eq.{channel_id}"})
        return str(rows[0].get("org_id") or "") or None if rows else None

    def start(self, job_ref: str, org_id: str) -> Optional[float]:
        return _num(self._rpc("start_credit_reservation", {"p_job_id": job_ref, "p_org": org_id}))

    def capture(self, job_ref: str, amount: float) -> Optional[float]:
        return _num(self._rpc("capture_credits",
                              {"p_job_id": job_ref, "p_actual": round_up(amount), "p_allow_over": False}))

    def release(self, job_ref: str) -> Optional[float]:
        return _num(self._rpc("release_credits", {"p_job_id": job_ref}))

    def expire(self) -> Optional[float]:
        return _num(self._rpc("expire_credit_reservations", {}))


# ── the two ends of a paid run ──────────────────────────────────────────────

@dataclass(frozen=True)
class Hold:
    """A started reservation this run must settle."""
    job_ref: str
    org_id: str
    amount: float


class CreditRefused(Exception):
    """The run must not start: the reason is safe to store and show."""


def open_hold(client, *, job_ref: Optional[str], channel_id: str,
              duration_s=None, enforce: bool) -> Optional[Hold]:
    """Before a run spends anything: find this channel's organization and claim
    the run's hold. Returns the Hold to settle at the end, or None when there
    is nothing to settle (exempt org, or not enforced and no hold).

    With ``enforce`` a run of a non-exempt organization needs an open hold of
    at least ``minimum_reservation`` — a browser can call reserve_credits
    directly and file a job against a token hold, so the runner checks too.
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
        amount = client.start(ref, org)
        if amount is None:
            if enforce:
                raise CreditRefused("its credit reservation is not open (expired, settled, or "
                                    "for another organization)")
            return None
        if enforce:
            minimum = minimum_reservation(client.prices(), duration_s)
            if minimum is not None and amount + 1e-9 < minimum:
                _safe(client.release, ref)
                raise CreditRefused(f"its reservation of {amount:.2f} credits is below the "
                                    f"{minimum:.2f} this run requires")
        return Hold(ref, org, float(amount))
    except CreditsUnavailable as e:
        if enforce:
            raise CreditRefused(f"credits are unavailable ({e})") from None
        logger.warning("credits: %s — run continues unsettled (enforcement is off)", e)
        return None


def settle_hold(client, hold: Hold, *, succeeded: bool, channel_id: str, since,
                ledger=local_run_entries) -> Optional[str]:
    """After the run: capture on success, release on failure. Returns a one-line
    description of what happened, or None when the credits API could not be
    reached (the hold then stays open and expires; logged as an error)."""
    try:
        if not succeeded:
            released = client.release(hold.job_ref)
            return f"released {float(released or 0):.2f} credits (run did not complete)"
        try:
            entries = ledger(channel_id, since)
        except Exception as e:
            logger.warning("credits: could not read the run's ledger (%s) — charging the hold",
                           type(e).__name__)
            entries = []
        try:
            prices = client.prices()
        except CreditsUnavailable as e:
            logger.warning("credits: prices unavailable (%s) — every entry counts as unpriced", e)
            prices = {}
        s = settle_amount(hold.amount, entries, prices)
        client.capture(hold.job_ref, s.amount)
        return "captured " + s.describe()
    except CreditsUnavailable as e:
        logger.error("credits: could not settle reservation %s (%s) — it stays open until it "
                     "expires; settle it by hand if this persists", hold.job_ref, e)
        return None


def _safe(fn, *args):
    try:
        return fn(*args)
    except CreditsUnavailable as e:
        logger.warning("credits: %s", e)
        return None
