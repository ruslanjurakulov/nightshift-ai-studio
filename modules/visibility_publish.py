"""Publish when approved — the worker's side of 0113.

An administrator switched "publish when approved" on for a channel; a person then approved ONE exact cut of an already
uploaded, PRIVATE video (0112); approving queued one ``video_visibility_requests`` row (0113). The queue worker
(``tools/queue_worker.py``) claims those rows with the service key and hands each to :func:`process_request`, which makes
the one change this feature exists for: ``videos.update`` with ``status.privacyStatus = public``. In order:

1. Everything is asked again, before any YouTube call and once more immediately before the write:
   ``video_publish_refusal(video_id, cut_sha256)`` with the cut hash recorded at approval (uploaded, gate verdict allowed,
   same cut, approved by a person, not expired, not public already, ...) and ``visibility_request_refusal(id)`` (the
   channel's switch is STILL on, this is still THE approval, the channel is connected). Any word is the end: refused (or
   expired) with that closed word, and YouTube is not called.
2. The channel's own token, resolved exactly as a render run resolves it (``youtube_publish_credentials``), in memory. A
   token without a scope that ``videos.update`` accepts (``youtube``, ``youtube.force-ssl``, ``youtubepartner``) is
   ``scope_missing``: ``youtube.upload`` alone is not enough, and nothing is asked of YouTube to find out.
3. The day's quota budget (``youtube_quota_take``): the write costs 50 units, the reads one each. No budget, no call.
4. YouTube is READ first: the video must exist on the channel the token reaches, be processed and not rejected, and be
   private. Already public after a crash that may have sent the write (``reconcile``) is the answer to our own write
   (applied); already public otherwise is somebody else's change (refused, ``already_public``); unlisted or scheduled is a
   person's choice and is never overridden (``privacy_changed``).
5. ``videos.update(part="status")`` ONCE, with the video's current writable status fields and ``privacyStatus`` public
   (the call replaces every field of the part it names, so the rest is sent back as read; never ``snippet``). The request
   is marked ``submitting`` in the database right before.
6. THE ANSWER IS NOT BELIEVED: the privacy is READ BACK. ``applied`` only when YouTube then says ``public``. A call that
   succeeded while the video stays private (an API project that has not passed YouTube's compliance audit gets its videos
   locked private) is ``refused`` with ``platform_kept_private``. ``videos.privacy`` follows the read-back and nothing else
   (``finish_visibility_request`` writes it).

Errors: 4xx policy answers are never retried (``platform_refused``); a quota answer ends the request (``quota_exceeded``,
a person tries again later); 401 / a refresh failure is ``token_expired``; 429 and 5xx / transport failures are retried
with backoff, three claims in all, and after an ambiguous failure the next claim READS first (the database says
``reconcile``) so a write that did reach YouTube is recognised, never repeated blindly. Nothing here ever prints a token, a
response body or a provider's message: the database stores a closed word and nothing else.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Callable, Mapping, Optional

logger = logging.getLogger(__name__)

#: The words a request may end with: the same list as ``visibility_reason_words()`` (0113) and
#: ``command-center/lib/visibilityRequest.ts``; tests/test_visibility_publish.py pins the three equal.
REASONS = (
    "video_not_found", "not_uploaded", "gate_blocked", "gate_unknown", "rejected", "already_public", "no_preview",
    "cut_unknown", "cut_changed", "not_approved", "approval_expired",
    "not_enabled", "approval_superseded", "channel_not_connected",
    "scope_missing", "token_expired", "quota_exceeded", "rate_limited", "video_not_found_on_youtube", "channel_mismatch",
    "still_processing", "rejected_by_youtube", "privacy_changed", "platform_refused", "platform_kept_private",
    "platform_error", "readback_failed",
    "interrupted", "worker_error",
)

#: Which end each word is: a rule said no for this approved cut (refused), the approval ran out (expired), or the
#: environment could not do it and a person may try again while the approval holds (failed).
EXPIRED = frozenset({"approval_expired"})
FAILED = frozenset({
    "channel_not_connected", "scope_missing", "token_expired", "quota_exceeded", "rate_limited", "still_processing",
    "platform_error", "readback_failed", "interrupted", "worker_error",
})


def status_of(reason: str) -> str:
    """refused | failed | expired for a closed word."""
    if reason in EXPIRED:
        return "expired"
    if reason in FAILED:
        return "failed"
    return "refused"


#: YouTube Data API v3 quota units (https://developers.google.com/youtube/v3/determine_quota_cost).
UNITS_LIST = 1
UNITS_CHANNEL_CHECK = 1
UNITS_UPDATE = 50
#: The Google Cloud project's whole day is 10,000 units; this feature's own ceiling per day, from the environment.
DEFAULT_DAILY_UNITS = 1000
PROJECT_POOL = 10000
MAX_CLAIMS = 3
#: Seconds to wait before the n-th retry (n = the claim that just failed).
BACKOFF_SECONDS = (30, 120, 600)

#: videos.update accepts one of these (https://developers.google.com/youtube/v3/docs/videos/update).
#: ``youtube.upload`` is NOT among them.
UPDATE_SCOPES = frozenset({
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/youtube.force-ssl",
    "https://www.googleapis.com/auth/youtubepartner",
})
#: The mutable ``status`` fields videos.update takes. The part is REPLACED, so what was read goes back; ``publishAt`` is
#: never among them (a scheduled video is a person's plan: it is refused, not overwritten) and the read-only ones
#: (uploadStatus, failureReason, rejectionReason, madeForKids) are never sent.
WRITABLE_STATUS = ("embeddable", "license", "publicStatsViewable", "selfDeclaredMadeForKids", "containsSyntheticMedia")

_QUOTA = {"quotaExceeded", "dailyLimitExceeded", "uploadLimitExceeded"}
_RATE = {"rateLimitExceeded", "userRateLimitExceeded"}
_AUTH = {"authError", "unauthorized", "forbidden_token", "invalid_grant"}
_SCOPE = {"insufficientPermissions", "insufficientScopes", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"}
_GONE = {"videoNotFound", "notFound"}


class Stop(Exception):
    """End a request: ``status`` refused|failed|expired and a closed word (never a provider's text)."""

    def __init__(self, reason: str, status: Optional[str] = None):
        super().__init__(reason)
        self.reason = reason if reason in REASONS else "worker_error"
        self.status = status or status_of(self.reason)


class Retry(Exception):
    """Put the request back for another claim after a backoff (the database ends it after the third claim)."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason if reason in REASONS else "worker_error"


def refused(reason: str) -> Stop:
    return Stop(reason, "refused")


def failed(reason: str) -> Stop:
    return Stop(reason, "failed")


# ── Supabase (the service key; only the functions of 0113) ───────────────────


class VisibilityStore:
    """The queue, over PostgREST function calls. The service key has no table privilege on it (0113)."""

    def __init__(self, url: str, service_key: str, *, session=None, timeout: float = 30.0):
        self.url = (url or "").rstrip("/")
        self._key = service_key or ""
        self._http = session
        self._timeout = timeout

    def http(self):
        if self._http is None:
            import requests  # noqa: PLC0415

            self._http = requests.Session()
        return self._http

    def _rpc(self, name: str, payload: dict):
        r = self.http().post(f"{self.url}/rest/v1/rpc/{name}", json=payload,
                             headers={"apikey": self._key, "Authorization": f"Bearer {self._key}",
                                      "Content-Type": "application/json"},
                             timeout=self._timeout)
        if r.status_code == 404:
            return None  # 0113 not applied: nothing to do
        if r.status_code >= 300:
            raise RuntimeError(f"{name}: HTTP {r.status_code}")   # the status only, never the body
        return r.json()

    def claim(self, worker_id: str) -> Optional[dict]:
        out = self._rpc("claim_visibility_request", {"p_worker": worker_id})
        return out if isinstance(out, dict) and out.get("id") else None

    def video_refusal(self, video_id: str, cut_sha256: str) -> Optional[str]:
        """0112's rule for acting on an approval, asked with the cut hash recorded at approval."""
        out = self._rpc("video_publish_refusal", {"p_video_id": video_id, "p_cut_sha256": cut_sha256})
        return out if isinstance(out, str) and out else None

    def request_refusal(self, request_id) -> Optional[str]:
        out = self._rpc("visibility_request_refusal", {"p_request_id": request_id})
        return out if isinstance(out, str) and out else None

    def mark_submitting(self, request_id, worker_id: str) -> bool:
        return self._rpc("mark_visibility_submitting", {"p_request_id": request_id, "p_worker": worker_id}) is True

    def quota_take(self, project: str, units: int, ceiling: int) -> bool:
        return self._rpc("youtube_quota_take", {"p_project": project, "p_units": units, "p_ceiling": ceiling}) is True

    def finish(self, request_id, worker_id: str, status: str, reason: Optional[str], before: Optional[str],
               after: Optional[str], units: int, retry_seconds: Optional[int]) -> Optional[dict]:
        out = self._rpc("finish_visibility_request", {
            "p_request_id": request_id, "p_worker": worker_id, "p_status": status, "p_reason": reason,
            "p_before": before, "p_after": after, "p_units": int(units), "p_retry_seconds": retry_seconds})
        return out if isinstance(out, dict) else None


# ── YouTube ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class VideoState:
    found: bool
    channel_id: str = ""
    privacy: Optional[str] = None
    upload_status: str = ""
    rejection_reason: str = ""
    scheduled: bool = False
    status: Optional[Mapping] = None


def writable_status(current: Optional[Mapping], privacy: str = "public") -> dict:
    """The ``status`` object videos.update gets: what was read (writable fields only), privacy set, ``publishAt`` never."""
    body = {k: current[k] for k in WRITABLE_STATUS if isinstance(current, Mapping) and k in current}
    body["privacyStatus"] = privacy
    return body


class YouTubeVisibility:
    """The two calls this feature makes on a googleapiclient ``service`` (videos.list and videos.update)."""

    def __init__(self, service):
        self.service = service

    def read(self, video_id: str) -> VideoState:
        resp = self.service.videos().list(part="status,snippet", id=video_id).execute() or {}
        items = resp.get("items") or []
        if not items:
            return VideoState(False)
        item = items[0] if isinstance(items[0], Mapping) else {}
        st = item.get("status") if isinstance(item.get("status"), Mapping) else {}
        sn = item.get("snippet") if isinstance(item.get("snippet"), Mapping) else {}
        privacy = st.get("privacyStatus")
        return VideoState(
            True, str(sn.get("channelId") or ""), privacy if privacy in ("private", "unlisted", "public") else None,
            str(st.get("uploadStatus") or ""), str(st.get("rejectionReason") or ""), bool(st.get("publishAt")), st)

    def make_public(self, video_id: str, current_status: Optional[Mapping]) -> None:
        # part="status" only: naming snippet would overwrite the title, description and tags.
        self.service.videos().update(
            part="status", body={"id": video_id, "status": writable_status(current_status, "public")}).execute()


def _reasons(exc) -> set:
    from modules import social_publish  # noqa: PLC0415 — the one parser of an HttpError's reason words

    return set(social_publish._yt_reasons(exc))


def http_error(what: str, exc) -> Exception:
    """Stop or Retry for an error from YouTube or the token refresh. Reason words only, never the message or body."""
    from modules import upload_idempotency  # noqa: PLC0415

    status = upload_idempotency.http_status(exc)
    words = _reasons(exc)
    name = type(exc).__name__
    logger.info("visibility: youtube %s failed (%s%s)", what, f"HTTP {status}" if status else name,
                f", {sorted(words)[0]}" if words else "")
    if words & _QUOTA:
        return failed("quota_exceeded")
    if words & _RATE or status == 429:
        return Retry("rate_limited")
    if words & _SCOPE:
        return failed("scope_missing")
    if status == 401 or words & _AUTH or name == "RefreshError":
        return failed("token_expired")
    if status == 404 or words & _GONE:
        return refused("video_not_found_on_youtube")
    if status is not None and 400 <= status < 500:
        return refused("platform_refused")           # a policy answer: never retried
    if upload_idempotency.is_ambiguous(exc):
        return Retry("platform_error")
    return failed("worker_error")


def granted_scopes(token_json: str) -> set:
    """The scope names in the token document itself (never the credentials object, which holds what was ASKED)."""
    try:
        doc = json.loads(token_json or "")
    except ValueError:
        return set()
    scopes = doc.get("scopes") if isinstance(doc, dict) else None
    if isinstance(scopes, str):
        scopes = scopes.split()
    return {str(s) for s in scopes} if isinstance(scopes, list) else set()


# ── one request ──────────────────────────────────────────────────────────────

_YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


class Context:
    """What one request carries while it runs: the quota it spent and what YouTube said before."""

    def __init__(self):
        self.units = 0
        self.before: Optional[str] = None
        self.after: Optional[str] = None     # the last privacy YouTube reported for THIS video (the mirror follows it)


def process_request(
    req: Mapping, *, store, credentials: Callable[[str], tuple], service_factory: Callable[[str, object], object],
    worker_id: str, project: str = "default", ceiling: int = DEFAULT_DAILY_UNITS,
    sleep: Callable[[float], None] = time.sleep, readback_wait: float = 3.0,
) -> str:
    """Carry one claimed request to applied | refused | failed | expired, or back to queued. Never raises.

    ``credentials(channel_id)`` is ``youtube_publish_credentials`` (token_json, ChannelContext); ``service_factory`` builds
    the googleapiclient service bound to that channel (``YouTubeUploader.from_token_json(...).service``)."""
    rid = req.get("id")
    video_id = str(req.get("video_id") or "")
    cut = str(req.get("approved_cut_sha256") or "")
    channel_id = str(req.get("channel_id") or "")
    attempts = int(req.get("attempts") or 1)
    reconcile = bool(req.get("reconcile"))
    ctx = Context()

    def spend(units: int, limit: int) -> bool:
        if store.quota_take(project, units, limit):
            ctx.units += units
            return True
        return False

    def recheck() -> None:
        """Everything the database knows, asked again. A word ends the request; YouTube is not touched."""
        why = store.video_refusal(video_id, cut)
        if why:
            raise Stop(why)
        why = store.request_refusal(rid)
        if why:
            raise Stop(why)

    def end(status: str, reason: Optional[str], after: Optional[str] = None, retry: Optional[int] = None) -> str:
        store.finish(rid, worker_id, status, reason, ctx.before, after or ctx.after, ctx.units, retry)
        logger.info("visibility request %s: %s%s", rid, status, f" ({reason})" if reason else "")
        return status

    try:
        if not _YT_ID.match(video_id) or not re.fullmatch(r"[0-9a-f]{64}", cut):
            raise refused("not_uploaded")
        recheck()

        # The channel's own token, in memory; the scopes it was granted, read from the token itself.
        from modules import channel_tokens  # noqa: PLC0415

        try:
            token_json, channel = credentials(channel_id)
        except channel_tokens.ChannelTokenError:
            raise failed("token_expired") from None
        except (KeyError, ValueError):
            raise failed("channel_not_connected") from None
        if not token_json:
            raise failed("channel_not_connected")
        if not granted_scopes(token_json) & UPDATE_SCOPES:
            raise failed("scope_missing")
        expected_channel = str(getattr(getattr(channel, "credential", None), "youtube_channel_id", "") or "")

        # Budget for the channel check and the read; then sign in (a refresh, and channels.list inside).
        if not spend(UNITS_CHANNEL_CHECK + UNITS_LIST, ceiling):
            raise failed("quota_exceeded")
        try:
            service = service_factory(token_json, channel)
        except ValueError:
            raise failed("channel_not_connected") from None
        except Exception as e:
            raise http_error("sign-in", e) from None
        yt = YouTubeVisibility(service)

        try:
            state = yt.read(video_id)
        except Exception as e:
            raise http_error("read", e) from None
        ctx.before = state.privacy
        if not state.found:
            raise refused("video_not_found_on_youtube")
        if expected_channel and state.channel_id != expected_channel:
            raise refused("channel_mismatch")
        ctx.after = state.privacy          # this video, on this channel: what YouTube says is what the mirror will say
        if state.upload_status in ("rejected", "failed", "deleted") or state.rejection_reason:
            raise refused("rejected_by_youtube")
        if state.upload_status != "processed":
            raise Retry("still_processing")
        if state.privacy == "public":
            if reconcile:
                # an earlier claim may have sent the write: this IS its result, read back from YouTube (what it was
                # before our write is not known any more)
                ctx.before = None
                return end("applied", None, after="public")
            raise refused("already_public")
        if state.privacy != "private" or state.scheduled:
            raise refused("privacy_changed")

        # Immediately before acting: the database again (the video can change while YouTube is being read), the budget
        # for the write, and the marker that says "the write may have been sent".
        recheck()
        if not spend(UNITS_UPDATE, ceiling):
            raise failed("quota_exceeded")
        if not store.mark_submitting(rid, worker_id):
            logger.info("visibility request %s: lease lost before the write; leaving it", rid)
            return "queued"
        update_error = None
        try:
            yt.make_public(video_id, state.status)
        except Exception as e:
            update_error = http_error("update", e)
            if not isinstance(update_error, Retry):
                raise update_error from None
            # ambiguous (5xx / transport): the write may have landed. Fall through to the read-back, which decides.

        # The answer is not believed: read it back. At most two reads, a moment apart.
        after: Optional[str] = None
        for i in range(2):
            spend(UNITS_LIST, PROJECT_POOL)       # recorded, never withheld: the read-back is the truth
            try:
                after = yt.read(video_id).privacy
            except Exception as e:
                logger.info("visibility request %s: read-back failed (%s)", rid, type(e).__name__)
                after = None
            if after is not None:
                ctx.after = after
            if after == "public" or i == 1:
                break
            sleep(readback_wait)
        if after == "public":
            return end("applied", None, after="public")
        if update_error is not None:
            raise update_error                      # the write failed and the video is not public: retry (reconcile next)
        if after is None:
            raise Retry("readback_failed")
        if after == "unlisted":
            return end("refused", "privacy_changed", after=after)
        return end("refused", "platform_kept_private", after=after)
    except Stop as stop:
        return end(stop.status, stop.reason)
    except Retry as retry:
        wait = BACKOFF_SECONDS[min(max(attempts, 1), len(BACKOFF_SECONDS)) - 1]
        return end("queued", retry.reason, retry=wait)
    except Exception as e:  # anything unforeseen: the type only, and back to the queue so the next claim reads first
        logger.warning("visibility request %s: worker error (%s)", rid, type(e).__name__)
        try:
            return end("queued", "worker_error", retry=BACKOFF_SECONDS[min(max(attempts, 1), len(BACKOFF_SECONDS)) - 1])
        except Exception as e2:
            logger.warning("visibility request %s: could not record it (%s)", rid, type(e2).__name__)
            return "queued"


class VisibilityService:
    """What the queue worker calls between render jobs."""

    def __init__(self, url: str, service_key: str, *, worker_id: str, credentials: Callable[[str], tuple],
                 service_factory: Optional[Callable] = None, store=None, project: Optional[str] = None,
                 ceiling: Optional[int] = None, env: Optional[Mapping[str, str]] = None):
        env = os.environ if env is None else env
        self.store = store or VisibilityStore(url, service_key)
        self.worker_id = worker_id
        self.credentials = credentials
        self.service_factory = service_factory or _real_service
        self.project = _project(env.get("NIGHTSHIFT_YT_QUOTA_PROJECT", "")) if project is None else project
        self.ceiling = _ceiling(env.get("NIGHTSHIFT_VISIBILITY_DAILY_UNITS", "")) if ceiling is None else ceiling
        self._warned = False

    def run_once(self) -> bool:
        """Claim and process at most one request. True when one was handled."""
        try:
            req = self.store.claim(self.worker_id)
        except Exception as e:
            if not self._warned:
                logger.warning("visibility queue unavailable (%s)", str(e) if isinstance(e, RuntimeError)
                               else type(e).__name__)
                self._warned = True
            return False
        if not req:
            return False
        process_request(req, store=self.store, credentials=self.credentials, service_factory=self.service_factory,
                        worker_id=self.worker_id, project=self.project, ceiling=self.ceiling)
        return True


def _real_service(token_json: str, channel):
    from modules.youtube_uploader import YouTubeUploader  # noqa: PLC0415 — google libs only when needed

    return YouTubeUploader.from_token_json(token_json, channel).service


def _project(raw: str) -> str:
    raw = (raw or "").strip().lower()
    return raw if re.fullmatch(r"[a-z0-9._-]{1,64}", raw) else "default"


def _ceiling(raw: str) -> int:
    try:
        n = int((raw or "").strip())
    except ValueError:
        return DEFAULT_DAILY_UNITS
    return min(max(n, 0), PROJECT_POOL)


def enabled(env: Optional[Mapping[str, str]] = None) -> bool:
    """The worker's own switch: OFF unless NIGHTSHIFT_VISIBILITY_PUBLISH is on. A channel's switch is the second one."""
    env = os.environ if env is None else env
    return str(env.get("NIGHTSHIFT_VISIBILITY_PUBLISH", "off")).strip().lower() in ("on", "1", "true", "yes")


__all__ = ["VisibilityStore", "VisibilityService", "YouTubeVisibility", "process_request", "enabled", "REASONS", "status_of"]
