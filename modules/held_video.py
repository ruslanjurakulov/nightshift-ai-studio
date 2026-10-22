"""Give a run that did NOT upload a ``videos`` row of its own.

Why this exists
---------------
Until now the Supabase ``videos`` row appeared only after a successful YouTube
upload. A run the publish gate blocked, a run held because auto-publish is off,
a run waiting on a second admin's approval, and a scene repair's new cut
(``repaired_awaiting_review``) all ended with no row — so they had no Command
Center detail page, and the Storyboard's "Regenerate scene" button (which only
makes sense for a run that has NOT uploaded, see
``command-center/lib/sceneRepair.ts``) could never be shown for the only videos
that can actually be repaired.

The key
-------
A run is identified by ``(channel_id, slug)`` everywhere else already: the run
checkpoint is keyed by slug, ``scene_repair.invalidate_approvals`` finds a
run's rows by channel + slug, and a resume re-derives the same slug from the
topic. ``videos.video_id`` is the table's primary key and, for an uploaded
video, the YouTube id — which a held run does not have. So a held row gets a
deterministic stand-in id, :func:`held_video_id`, derived from that pair: a
re-held run (resume, repair) upserts the SAME row, and it can never collide
with a YouTube id (those are exactly 11 characters; this is longer and
prefixed). When the run later uploads, :func:`promote` re-keys that same row to
the YouTube id in one PATCH, so the uploaded video keeps its script, scenes and
manifest and there is never a second row for one run.

What it deliberately does NOT do
--------------------------------
It never uploads, publishes, or changes a video's privacy, and it is not part
of the publish gate: it runs after the gate and the approval check have
already decided, and only records what they decided. ``published_at``,
``privacy`` and the YouTube id stay NULL on a held row — a held video was not
published, and nothing here pretends otherwise (migration 0016 enforces it).
It writes nothing to the local SQLite store, so analytics, A/B readbacks and
watch-next — which all read that store — never see a held run.

Like ``video_review`` and ``supabase_sync``, nothing here raises into the
pipeline. A missing key, an outage or an un-migrated database is logged and
swallowed: a detail page is a convenience, and losing one must never turn a
finished run into a failed one.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Mapping, Optional

import requests

logger = logging.getLogger(__name__)

_TIMEOUT = 15  # seconds — a slow Supabase must not hang a finished run.

#: Prefix of a held row's stand-in video_id. Kept inside
#: ``scene_repair._VIDEO_ID_RE`` (``[A-Za-z0-9_-]{1,64}``) so a repair's
#: approval invalidation still finds the row.
HELD_ID_PREFIX = "run-"

# publish_state values (migration 0016). NULL is a row written before 0016.
STATE_BLOCKED = "blocked"                        # the publish gate blocked it
STATE_AWAITING_APPROVAL = "awaiting_approval"    # two-person approval pending
STATE_HELD = "held"                              # gate passed, auto-publish off
STATE_REPAIRED = "repaired_awaiting_review"      # a scene repair's new cut
STATE_UPLOADED = "uploaded"                      # promoted after a real upload

#: Fixed words for ``hold_detail.cause`` (the Command Center and the operator bot
#: show a sentence for each). All four mean "the cut is finished and passed the
#: gate, but the YouTube upload did not happen", and they need different
#: responses, which is why they are not one word:
#:   upload_failed         the upload raised for any other reason
#:   quota_exceeded        YouTube's daily API quota is used up (quotaExceeded):
#:                         it comes back by itself, send again tomorrow
#:   upload_limit_exceeded the CHANNEL hit its own upload limit (uploadLimitExceeded)
#:   token_expired         the connection to the channel is broken (revoked or
#:                         expired refresh token): reconnect YouTube
CAUSE_UPLOAD_FAILED = "upload_failed"
CAUSE_QUOTA_EXCEEDED = "quota_exceeded"
CAUSE_UPLOAD_LIMIT_EXCEEDED = "upload_limit_exceeded"
CAUSE_TOKEN_EXPIRED = "token_expired"
HOLD_CAUSES = (CAUSE_UPLOAD_FAILED, CAUSE_QUOTA_EXCEEDED, CAUSE_UPLOAD_LIMIT_EXCEEDED, CAUSE_TOKEN_EXPIRED)

_QUOTA_REASONS = frozenset({"quotaExceeded", "dailyLimitExceeded"})
_UPLOAD_LIMIT_REASONS = frozenset({"uploadLimitExceeded"})
_AUTH_REASONS = frozenset({"authError"})


def _error_reasons(exc) -> list:
    """The reason WORDS YouTube put on an ``HttpError`` (quotaExceeded, ...),
    never its message or body."""
    reasons: list = []
    details = getattr(exc, "error_details", None)
    if isinstance(details, list):
        reasons += [d.get("reason") for d in details if isinstance(d, dict)]
    if not reasons:
        try:
            content = getattr(exc, "content", b"") or b""
            doc = json.loads(content.decode("utf-8") if isinstance(content, bytes) else str(content))
            errs = ((doc or {}).get("error") or {}).get("errors") or []
            reasons += [e.get("reason") for e in errs if isinstance(e, dict)]
        except Exception:
            pass
    return [r for r in reasons if isinstance(r, str) and re.fullmatch(r"[A-Za-z_]{1,64}", r)]


def upload_failure_cause(exc: BaseException) -> str:
    """Which word of :data:`HOLD_CAUSES` a failed upload gets.

    Decided from YouTube's structured reason (and the type of a refresh error),
    never from message text: text can say anything, and it is never stored. An
    exception this does not recognise is ``upload_failed``, which is what every
    failure was before the others had words."""
    from modules import upload_idempotency  # noqa: PLC0415 - keep this module's import light

    reasons = set(_error_reasons(exc))
    if reasons & _QUOTA_REASONS:
        return CAUSE_QUOTA_EXCEEDED
    if reasons & _UPLOAD_LIMIT_REASONS:
        return CAUSE_UPLOAD_LIMIT_EXCEEDED
    if (type(exc).__name__ == "RefreshError" or reasons & _AUTH_REASONS
            or upload_idempotency.http_status(exc) == 401):
        return CAUSE_TOKEN_EXPIRED
    return CAUSE_UPLOAD_FAILED


HELD_STATES = (STATE_BLOCKED, STATE_AWAITING_APPROVAL, STATE_HELD, STATE_REPAIRED)
ALL_STATES = HELD_STATES + (STATE_UPLOADED,)

# Columns migration 0016 adds. A database without it rejects any write that
# names one; the write is then retried without them (see _is_missing_column).
_COLUMNS_0016 = ("publish_state", "held_at", "hold_detail")
# Migration 0112: the cut's hash and the gate's verdict for it. Dropped FIRST when a database does not have them
# yet, so the state and the hold detail (0016) still land.
COLUMNS_0112 = ("cut_sha256", "gate_verdict")
# Older optional columns (0011 scenes, 0013 manifest), dropped next if a write
# is still refused, so the row itself lands on the oldest supported schema.
_COLUMNS_OPTIONAL = ("manifest", "scenes", "preview_path")


def held_video_id(channel_id: str, slug: str) -> str:
    """The stand-in ``video_id`` for run ``slug`` of ``channel_id``.

    Deterministic, so every hold of the same run lands on the same row. Hashed
    rather than concatenated: a slug is up to 50 characters and a channel id is
    free text, and the id must stay short, URL-safe and within the pattern the
    rest of the pipeline accepts for a video id."""
    digest = hashlib.sha256(f"{channel_id}\n{slug}".encode("utf-8")).hexdigest()
    return HELD_ID_PREFIX + digest[:20]


def gate_detail(reason: str, gate_meta: Optional[Mapping] = None) -> dict:
    """What the row keeps about why it is held: the reason and the gate's own
    verdict — its block/warning names and the checks it ran, never script or
    claim text (``PublishGateResult.to_metadata`` carries none either). The
    bulky QC/rights reports stay in the gate event."""
    detail: dict = {"reason": str(reason)}
    if isinstance(gate_meta, Mapping):
        # Why a gate-passed run is held anyway. Only a fixed word from
        # HOLD_CAUSES is kept — never free text such as an exception message,
        # which could carry a token or a URL.
        cause = gate_meta.get("reason")
        if cause in HOLD_CAUSES:
            detail["cause"] = cause
        detail["gate"] = {
            "allowed": bool(gate_meta.get("allowed")),
            "blocks": [str(b) for b in (gate_meta.get("blocks") or [])],
            "warnings": [str(w) for w in (gate_meta.get("warnings") or [])],
            "checks_run": [str(c) for c in (gate_meta.get("checks_run") or [])],
        }
    return detail


#: At most this many flagged texts, each cut to a fixed length, go into ``hold_detail.flagged``.
MAX_FLAGGED_IN_DETAIL = 20
MAX_FLAGGED_TEXT = 200
MAX_FLAGGED_REASONING = 300


#: At most this many cited sources ride on one flagged text or one hold.
MAX_SOURCES_PER_CLAIM = 3
MAX_SOURCES_IN_DETAIL = 30


def grounding_sources(result) -> list:
    """The Wikipedia pages the evidence lookup cited for one claim, ``[{id, title, url}]``: only
    pages that changed its verdict (a quote that backed it, or a contradiction). Titles and
    links of public pages, never script text. Never raises."""
    try:
        record = getattr(result, "grounding", None) or {}
        if record.get("effect") not in ("upgraded", "flagged"):
            return []
        return [{"id": str(s.get("id", ""))[:12], "title": str(s.get("title", ""))[:200],
                 "url": str(s.get("url", ""))[:500]}
                for s in (record.get("sources") or [])[:MAX_SOURCES_PER_CLAIM]
                if str(s.get("url", "")).startswith("https://en.wikipedia.org/")]
    except Exception:
        return []


def grounding_detail(summary) -> Optional[dict]:
    """What ``hold_detail.grounding`` keeps of the evidence lookup: whether it ran, why it was
    unavailable, the counts and the sources it cited (title, link, snippet ids). None when
    grounding recorded nothing. Fixed words and public page titles only."""
    if not isinstance(summary, Mapping):
        return None
    keys = ("enabled", "unavailable", "wiki_language", "script_language", "requests", "failed_requests",
            "snippets", "claims_with_evidence", "supported", "contradicted", "upgraded", "flagged_by_evidence",
            "clamped_verdicts", "upgrade_cap", "refused_by_cap", "second_chance", "reused")
    out = {k: summary.get(k) for k in keys if k in summary}
    out["cleared"] = [{"claim_id": str(c.get("claim_id", ""))[:24], "title": str(c.get("title", ""))[:200],
                       "url": str(c.get("url", ""))[:500], "quote": str(c.get("quote", ""))[:300]}
                      for c in (summary.get("cleared") or [])[:20]
                      if isinstance(c, Mapping) and str(c.get("url", "")).startswith("https://en.wikipedia.org/")]
    out["sources"] = [{"title": str(s.get("title", ""))[:200], "url": str(s.get("url", ""))[:500],
                       "ids": [str(i)[:12] for i in (s.get("ids") or [])][:10], "claims": int(s.get("claims") or 0)}
                      for s in (summary.get("sources") or [])[:MAX_SOURCES_IN_DETAIL]
                      if isinstance(s, Mapping) and str(s.get("url", "")).startswith("https://en.wikipedia.org/")]
    return out


def flagged_claims(claims, results) -> list:
    """The checked texts that ship OUTSIDE the narration and that the fact-check did
    not clear (title, A/B title, description, thumbnail text, hook sentence, the
    alternate hook): ``[{source, verdict, reasoning, text}]``, capped in count and
    length. The storyboard's scenes already list the narration's own claims; these
    belong to no scene, so without this the owner would see "0 flagged" on a run
    that was held for its title. The strings are model-written, never a secret.
    A checker's unresolved sentinel is not a finding and is left out. Never raises."""
    out: list = []
    try:
        claims = list(claims or [])
        for claim, r in zip(claims, list(results or [])):
            source = str(getattr(claim, "source", "narration") or "narration")
            if source == "narration" or getattr(r, "unresolved", False):
                continue
            if not getattr(r, "requires_human_review", False):
                continue
            entry = {
                "source": source,
                "verdict": str(getattr(r, "verdict", "") or "unverifiable"),
                "reasoning": str(getattr(r, "reasoning", "") or "")[:MAX_FLAGGED_REASONING],
                "text": str(getattr(claim, "text", "") or "")[:MAX_FLAGGED_TEXT],
            }
            cited = grounding_sources(r)
            if cited:
                entry["sources"] = cited
            out.append(entry)
            if len(out) >= MAX_FLAGGED_IN_DETAIL:
                break
    except Exception:
        return out
    return out


def gate_verdict(gate_meta: Optional[Mapping]) -> Optional[dict]:
    """The publish gate's verdict as ``videos.gate_verdict`` keeps it (migration 0112): allowed, the block and warning
    names, the checks that ran. ``None`` when there is no verdict: a row with no verdict reads as unknown, never as a
    pass (CLAUDE.md rule 5), so a cut nobody gated is never offered for approval."""
    if not isinstance(gate_meta, Mapping) or not isinstance(gate_meta.get("allowed"), bool):
        return None
    return {
        "allowed": gate_meta["allowed"],
        "blocks": [str(b) for b in (gate_meta.get("blocks") or [])],
        "warnings": [str(w) for w in (gate_meta.get("warnings") or [])],
        "checks_run": [str(c) for c in (gate_meta.get("checks_run") or [])],
    }


def cut_sha256(path) -> Optional[str]:
    """sha256 of the final master at ``path`` (the cut a person approves), or None when it cannot be read."""
    if not path:
        return None
    from modules import video_ir

    return video_ir.file_sha256(path)


class HeldVideos:
    """Writes held rows and promotes them on upload. Inert without keys."""

    def __init__(self, url: Optional[str] = None, service_key: Optional[str] = None):
        self.url = (url if url is not None else os.getenv("SUPABASE_URL", "")).rstrip("/")
        self.service_key = service_key if service_key is not None else os.getenv("SUPABASE_SERVICE_KEY", "")
        self.enabled = bool(self.url and self.service_key)

    def _headers(self, prefer: str) -> dict:
        headers = {
            "apikey": self.service_key,
            "Authorization": f"Bearer {self.service_key}",
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        return headers

    # ── writing a held row ─────────────────────────────────────────────────
    def record_held(
        self,
        *,
        channel_id: str,
        slug: str,
        state: str,
        topic: Optional[str] = None,
        title: Optional[str] = None,
        script_text: Optional[str] = None,
        scenes: Optional[list] = None,
        manifest: Optional[dict] = None,
        local_path: Optional[str] = None,
        detail: Optional[dict] = None,
        now: Optional[str] = None,
        fill_if_new: Optional[Mapping] = None,
        no_cut: bool = False,
    ) -> Optional[str]:
        """Upsert this run's held row. Returns its video_id, or None when
        nothing was written. Never raises.

        Fields left as None are not sent, so a later hold that knows less (a
        repair has no chosen title) never blanks what an earlier one wrote.
        ``published_at`` and ``privacy`` are always sent as NULL: whatever this
        row said before, the run is not uploaded now.

        ``no_cut`` says this hold has NO video (the run stopped before the render): the
        row's ``local_path`` and ``preview_path`` are sent as NULL. Without it a re-run
        of the same topic (same row key) would keep the previous cut's preview under
        the new text, since fields left as None are not sent.

        ``fill_if_new`` (title / script_text / scenes) is written only when the
        run has no row yet — a repair knows the saved script but not the chosen
        title or the claim-annotated scenes the first hold recorded, and must
        not overwrite them with less. When the lookup fails it is not sent."""
        try:
            if not self.enabled:
                return None
            if state not in HELD_STATES:
                logger.warning("Not recording held row: unknown state %r", state)
                return None
            if not channel_id or not slug:
                return None
            video_id = held_video_id(channel_id, slug)
            row: dict = {
                "video_id": video_id,
                "channel_id": channel_id,
                "slug": slug,
                "published_at": None,
                "privacy": None,
                # Honest default: nobody has looked at THIS cut yet.
                "review_state": "pending",
                "publish_state": state,
                "held_at": now or datetime.now(timezone.utc).isoformat(),
            }
            if detail:
                row["hold_detail"] = detail
            # 0112: the verdict and the hash of THIS cut. A hold that carries no gate (a repair's new cut) writes
            # NULL, which reads "unknown": the previous cut's verdict does not judge this one.
            row["gate_verdict"] = gate_verdict((detail or {}).get("gate"))
            row["cut_sha256"] = cut_sha256(local_path)
            if fill_if_new and self._exists(video_id) is False:
                title = title or fill_if_new.get("title")
                script_text = script_text or fill_if_new.get("script_text")
                scenes = scenes or fill_if_new.get("scenes")
            for key, value in (("topic", topic), ("title", title),
                               ("script_text", script_text), ("local_path", local_path)):
                if value:
                    row[key] = value
            if no_cut:
                # Nothing of an earlier cut of this run survives under the new text.
                row["local_path"] = None
                row["preview_path"] = None
                row["manifest"] = None
            if manifest:
                from modules import video_ir

                scenes = video_ir.annotate_scenes(scenes, manifest)
                row["manifest"] = manifest
            if scenes:
                row["scenes"] = scenes
            if self._upsert(row):
                logger.info("[channel: %s] Held run %s recorded as %s (%s)",
                            channel_id, slug, video_id, state)
                return video_id
            return None
        except Exception as e:
            logger.warning("Could not record the held run (%s: %s) — the run is unaffected",
                           type(e).__name__, e)
            return None

    def has_cut(self, video_id: str) -> Optional[bool]:
        """Does this run's row already hold a cut a person could be reviewing (a preview or a local
        path)? False when there is no such row, or when this client is inert (nothing to protect);
        None when the lookup failed, which a caller that would overwrite the row must read as
        "maybe"."""
        if not self.enabled:
            return False
        resp = self._send("get", {"video_id": f"eq.{video_id}", "select": "preview_path,local_path"}, None, "")
        if resp is None or resp.status_code >= 300:
            return None
        return any(bool(r.get("preview_path") or r.get("local_path")) for r in _json_list(resp))

    def _exists(self, video_id: str) -> Optional[bool]:
        """Is there a row for this id? None when the lookup failed."""
        resp = self._send("get", {"video_id": f"eq.{video_id}", "select": "video_id"}, None, "")
        if resp is None or resp.status_code >= 300:
            return None
        return bool(_json_list(resp))

    def _upsert(self, row: dict) -> bool:
        attempts = [row]
        without_0112 = {k: v for k, v in row.items() if k not in COLUMNS_0112}
        attempts.append(without_0112)
        without_0016 = {k: v for k, v in without_0112.items() if k not in _COLUMNS_0016}
        attempts.append(without_0016)
        attempts.append({k: v for k, v in without_0016.items() if k not in _COLUMNS_OPTIONAL})
        for i, body in enumerate(attempts):
            if i and body == attempts[i - 1]:
                continue
            resp = self._send("post", {"on_conflict": "video_id"}, body,
                              "resolution=merge-duplicates,return=minimal")
            if resp is not None and resp.status_code < 300:
                if i:
                    logger.info("Held row written on an older schema — apply migration 0016 "
                                "(and 0011/0013) to keep its state, scenes and manifest")
                return True
            if resp is None or not _is_missing_column(resp):
                return False
        return False

    # ── on upload ──────────────────────────────────────────────────────────
    def promote(
        self,
        *,
        channel_id: str,
        slug: str,
        youtube_id: str,
        published_at: str,
        privacy: str,
        title: Optional[str] = None,
        topic: Optional[str] = None,
        category_id: Optional[str] = None,
        local_path: Optional[str] = None,
        thumbnail_variant: Optional[str] = None,
        title_variant: Optional[str] = None,
    ) -> bool:
        """Re-key this run's held row (if it has one) to the YouTube id and
        record the upload on it. Returns True when a held row was promoted or
        merged away. Never raises.

        Called only after a successful upload, with the upload's own id, time
        and privacy — the same values ``StateStore.record_video`` stores, and
        the same ones the Supabase mirror later upserts onto this row by
        video_id, so the two agree. No held row (the run uploaded on its first
        pass, or before 0016) is a no-op: that path is exactly as before."""
        try:
            if not self.enabled or not channel_id or not slug or not youtube_id:
                return False
            held_id = held_video_id(channel_id, slug)
            if youtube_id == held_id:
                return False
            patch: dict = {
                "video_id": youtube_id,
                "published_at": published_at,
                "privacy": privacy,
                "publish_state": STATE_UPLOADED,
            }
            for key, value in (("title", title), ("topic", topic), ("category_id", category_id),
                               ("local_path", local_path), ("thumbnail_variant", thumbnail_variant),
                               ("title_variant", title_variant)):
                if value:
                    patch[key] = value
            # 0112: the row is now an uploaded video, and what the hold knew about the cut is not about THIS upload.
            # The hash is the master that was just uploaded; the verdict is cleared (unknown) until the review record
            # that follows writes the gate's verdict for it, so a failure there can only leave "unknown", never a stale pass.
            patch["cut_sha256"] = cut_sha256(local_path)
            patch["gate_verdict"] = None
            filters = {"video_id": f"eq.{held_id}", "channel_id": f"eq.{channel_id}"}
            without_0112 = {k: v for k, v in patch.items() if k not in COLUMNS_0112}
            for body in (patch, without_0112, {k: v for k, v in without_0112.items() if k not in _COLUMNS_0016}):
                resp = self._send("patch", filters, body, "return=representation")
                if resp is None:
                    return False
                if resp.status_code < 300:
                    promoted = bool(_json_list(resp))
                    if promoted:
                        logger.info("[channel: %s] Held row %s promoted to %s", channel_id, held_id, youtube_id)
                    return promoted
                if resp.status_code == 409:
                    # A row for this YouTube id already exists (the mirror got
                    # there first). One run, one row: drop the stand-in; the
                    # review record that follows the upload refills the scenes.
                    # Its preview object must not be orphaned, and must not go before the new
                    # preview exists: hand the pointer to the surviving row (when it has none), so
                    # the review record that follows the upload deletes it after recording the new one.
                    old_preview = self._preview_path(held_id)
                    if old_preview and self._preview_path(youtube_id) is None:
                        self._send("patch", {"video_id": f"eq.{youtube_id}", "channel_id": f"eq.{channel_id}"},
                                   {"preview_path": old_preview}, "return=minimal")
                    return self._delete(filters)
                if not _is_missing_column(resp):
                    logger.warning("Could not promote held row %s (HTTP %s)", held_id, resp.status_code)
                    return False
            return False
        except Exception as e:
            logger.warning("Could not promote the held row (%s: %s) — the upload is unaffected",
                           type(e).__name__, e)
            return False

    def _preview_path(self, video_id: str) -> Optional[str]:
        resp = self._send("get", {"video_id": f"eq.{video_id}", "select": "preview_path"}, None, "")
        if resp is None or resp.status_code >= 300:
            return None
        rows = _json_list(resp)
        path = rows[0].get("preview_path") if rows and isinstance(rows[0], dict) else None
        return path if isinstance(path, str) and path else None

    def _delete(self, filters: dict) -> bool:
        resp = self._send("delete", filters, None, "return=minimal")
        ok = resp is not None and resp.status_code < 300
        if not ok:
            logger.warning("Could not remove a superseded held row (%s)",
                           getattr(resp, "status_code", "no response"))
        return ok

    # ── transport ──────────────────────────────────────────────────────────
    def _send(self, method: str, params: dict, body, prefer: str):
        """One PostgREST call on ``videos``; the response, or None on a
        network error. The key is sent only as a header and never logged."""
        try:
            kwargs = {"params": params, "headers": self._headers(prefer), "timeout": _TIMEOUT}
            if body is not None:
                kwargs["json"] = body
            return getattr(requests, method)(f"{self.url}/rest/v1/videos", **kwargs)
        except Exception as e:
            logger.warning("Supabase %s on videos errored (%s)", method.upper(), type(e).__name__)
            return None


def _is_missing_column(resp) -> bool:
    """Did PostgREST refuse the write because a column does not exist yet (an
    un-migrated database)? Anything else — a check violation, a bad key — is
    not retried: dropping columns would not fix it."""
    if getattr(resp, "status_code", 0) not in (400, 404):
        return False
    try:
        text = str(resp.text or "")
    except Exception:
        return False
    if "PGRST204" in text or "42703" in text:
        return True
    return "column" in text.lower() and ("does not exist" in text or "Could not find" in text)


def _json_list(resp) -> list:
    try:
        data = resp.json()
    except Exception:
        return []
    return data if isinstance(data, list) else []


# ── module-level conveniences for main.py / scene_repair ────────────────────

def record_held(**kwargs) -> Optional[str]:
    """``HeldVideos().record_held(...)``, never raising."""
    try:
        return HeldVideos().record_held(**kwargs)
    except Exception as e:
        logger.warning("Could not record the held run (%s: %s)", type(e).__name__, e)
        return None


def promote(**kwargs) -> bool:
    """``HeldVideos().promote(...)``, never raising."""
    try:
        return HeldVideos().promote(**kwargs)
    except Exception as e:
        logger.warning("Could not promote the held row (%s: %s)", type(e).__name__, e)
        return False
