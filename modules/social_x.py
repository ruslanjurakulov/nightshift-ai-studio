"""X (Twitter) video posts - the adapter behind ``social_publish.XPublisher``. DARK.

Nothing can reach this code today: ``social_accounts`` / ``publish_requests`` (0028 / 0029) do not allow the word ``x``,
there is no connect flow, and there is no X developer app. It exists so that the day the owner has an app (and has
decided who pays per post) the adapter is already written, tested against a loopback fake and reviewed.

Flow (official pages, read 2026-10-25: https://docs.x.com/x-api/media/quickstart/media-upload-chunked,
https://docs.x.com/x-api/media/media-upload-status, https://docs.x.com/x-api/posts/create-post):

1. ``POST /2/media/upload/initialize`` JSON ``{media_type, total_bytes, media_category: "tweet_video"}`` -> ``data.id``;
2. ``POST /2/media/upload/{id}/append`` multipart ``segment_index`` + ``media``, segments of 4 MB (X: 5 MB recommended,
   8 MB the server maximum). A lost APPEND answer is retried for the SAME segment index (re-sending a segment is not a
   publish), at most ``APPEND_TRIES`` times;
3. ``POST /2/media/upload/{id}/finalize`` -> ``data.processing_info`` when X still has work to do;
4. ``GET /2/media/upload?command=STATUS&media_id={id}`` until ``processing_info.state`` is ``succeeded`` (``failed`` ends it);
5. ``POST /2/tweets`` ``{text, media: {media_ids: [id]}}`` plus ``made_with_ai: true`` only when the AI decision is true.

What this module holds to (each has a test in tests/test_social_x.py):

* **The token goes to one fixed host.** Every URL is ``https://api.x.com/2`` + a fixed path + an id that passed
  ``^[0-9]{1,19}$``. No URL from an answer is ever requested, so there is no vendor-supplied address to vet (compare
  ``social_facebook``, where ``upload_url`` is). No redirect is followed (a 3xx is a failure). The token travels in the
  ``Authorization`` header only. Nothing X says (``title``, ``detail``, ``message``) is copied into an error or a log
  line: only our own words, the HTTP status, a ``Problem`` type word and the reset time of a rate limit.
* **Hard byte cap.** The file must be within ``X_MAX_BYTES`` before anything is sent and is measured again before INIT; each
  segment is read as ``min(segment, total - offset)`` bytes, so a file that grew is cut at the measured size, and one that
  shrank ends the upload (``upload_failed``) instead of finalizing a short file.
* **A post is never retried.** ``POST /2/tweets`` is the only call that makes anything public, and X has no idempotency key
  for it. If its answer is lost (timeout, dropped connection, 5xx, a 2xx without a post id) the request ends FAILED as
  ``publish_unconfirmed`` ("check the account's timeline before sending again") and nothing is sent twice. There is no
  read-back: finding our own post again means a paid timeline read (X bills reads per resource) that matches on text, which can
  be fooled; a person looking at the timeline cannot. A stale ``processing`` row is failed as ``interrupted`` by the queue
  (0029) and never re-queued. A lost answer on INIT / APPEND / FINALIZE leaves only an unposted upload that X expires.
* **No link in the post text.** X bills "Post create with a URL" at $0.200 and a plain post at $0.015 (pricing page, read
  2026-10-24, no "as of" date), so ``social_captions.x_caption`` removes links; the app is billed for every post.
* **Public at once.** X has no draft or private state in this API, like Instagram: the approve-before-publish gate
  (``publish_request_refusal``, CLAUDE.md #2 and #3) is the only control, and it ran just before this.
* **AI disclosure.** ``made_with_ai`` is a field of the official create-post page (a boolean "Discloses that the post
  contains AI-generated media"); it is sent only when true, and the standard disclosure line is also in the text.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Callable, Optional

from modules import social_probe
from modules import social_publish as sp
from modules import social_tokens

API = "https://api.x.com/2"
MEDIA_CATEGORY = "tweet_video"
MEDIA_TYPE = "video/mp4"
SEGMENT_BYTES = 4 * 1024 * 1024
APPEND_TRIES = 3
MAX_API_BODY = 1024 * 1024
MAX_UNREADABLE_POLLS = 3
MIN_CHECK_AFTER, MAX_CHECK_AFTER = 1, 30

#: The closed words this module uses beyond the common ones (sentences in en / ru / uz: command-center/lib/publish.ts).
REASON_UNCONFIRMED = "publish_unconfirmed"
REASON_PERMISSION = "permission_missing"
REASON_DUPLICATE = "duplicate_post"
REASON_CREDITS = "credits_exhausted"
REASONS = (REASON_UNCONFIRMED, REASON_PERMISSION, REASON_DUPLICATE, REASON_CREDITS)

_ID = re.compile(r"[0-9]{1,19}")
_TYPE_WORD = re.compile(r"[A-Za-z0-9:/._-]{1,80}")
_REDIRECTS = (301, 302, 303, 307, 308)


class _Lost(Exception):
    """The request left, and the answer did not come back (or was unusable): the outcome is not known."""

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


def _close(r) -> None:
    try:
        r.close()
    except Exception:
        pass


def _read_doc(r) -> Optional[dict]:
    """The JSON object of an answer, read through a size cap; None when it is not one (an empty body included)."""
    try:
        declared = int((getattr(r, "headers", None) or {}).get("Content-Length") or 0)
    except (TypeError, ValueError):
        declared = 0
    if declared > MAX_API_BODY:
        _close(r)
        return None
    stream = getattr(r, "iter_content", None)
    try:
        if stream is None:
            body = r.json()
        else:
            buf = bytearray()
            for chunk in stream(chunk_size=65536):
                buf += chunk
                if len(buf) > MAX_API_BODY:
                    return None
            body = json.loads(bytes(buf).decode("utf-8")) if buf else None
    except Exception:
        return None
    finally:
        _close(r)
    return body if isinstance(body, dict) else None


def _int(v) -> Optional[int]:
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _reset_minutes(r, now: Optional[float] = None) -> Optional[int]:
    """Whole minutes until ``x-rate-limit-reset`` (epoch seconds), when X sent one that makes sense."""
    try:
        raw = (getattr(r, "headers", None) or {}).get("x-rate-limit-reset")
        when = int(str(raw).strip()) if raw is not None and len(str(raw)) <= 12 else None
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    left = when - (time.time() if now is None else now)
    return int(left // 60) + 1 if 0 < left <= 24 * 3600 else None


def x_error(what: str, r, doc: Optional[dict]) -> sp.PublishStop:
    """A refused request as a closed reason word plus our own detail (status, ``Problem`` type, rate-limit reset). The
    classification reads X's ``detail`` text to choose a word; the text itself is never copied."""
    status = getattr(r, "status_code", 0)
    problem = doc.get("type") if isinstance(doc, dict) else None
    parts = [f"HTTP {status}"]
    if isinstance(problem, str) and _TYPE_WORD.fullmatch(problem) and problem != "about:blank":
        parts.append(problem.rsplit("/", 1)[-1])
    detail = f"x {what}: {', '.join(parts)}"
    text = json.dumps(doc)[:4096].lower() if isinstance(doc, dict) else ""
    if status == 401:
        return sp.failed("token_expired", detail + " - reconnect the account")
    if status == 402:
        return sp.failed(REASON_CREDITS, detail + " - the platform reports no usage credits left (unverified meaning of 402)")
    if status == 429:
        wait = _reset_minutes(r)
        return sp.failed("rate_limited", detail + (f" - X says to retry in about {wait} min" if wait else ""))
    if status == 403:
        if "duplicate" in text:
            return sp.failed(REASON_DUPLICATE, detail + " - X refuses a post it has seen before")
        if "longer than" in text or "video" in text and "not allowed" in text:
            return sp.failed("too_long", detail + " - this account's X video length limit is lower than the file's")
        return sp.failed(REASON_PERMISSION, detail + " - reconnect the account and allow posting and media upload")
    return sp.failed("platform_error", detail)


class XVideoAdapter:
    """``publish`` returns ``{"result_id": post id, "result_url": https://x.com/i/status/<id>, "privacy": None}`` or raises
    ``sp.PublishStop``. ``api`` is for the loopback tests; the default is the official host and nothing reads it from the
    environment."""

    def __init__(self, http, *, sleep: Callable[[float], None] = time.sleep,
                 heartbeat: Callable[[], None] = lambda: None, poll_seconds: float = sp.POLL_SECONDS,
                 max_wait: float = sp.MAX_WAIT_SECONDS, api: str = API, max_bytes: int = sp.X_MAX_BYTES,
                 segment_bytes: int = SEGMENT_BYTES):
        self.http, self.sleep, self.heartbeat = http, sleep, heartbeat
        self.poll_seconds, self.max_wait = poll_seconds, max_wait
        self.api, self.max_bytes, self.segment_bytes = api.rstrip("/"), max_bytes, segment_bytes

    # -- one HTTP call ------------------------------------------------------------
    @staticmethod
    def _auth(tok) -> dict:
        return {"Authorization": f"Bearer {tok.access_token}"}

    def _send(self, method: str, url: str, what: str, **kw):
        try:
            r = getattr(self.http, method)(url, allow_redirects=False, stream=True, **kw)
        except Exception as e:  # network, TLS, timeout: the type only, never the message
            raise _Lost(f"x {what}: {type(e).__name__}") from None
        status = getattr(r, "status_code", 0)
        if status in _REDIRECTS:
            _close(r)
            raise sp.failed("platform_error", f"x {what}: HTTP {status} - a redirect is never followed")
        return r

    def _call(self, method: str, url: str, what: str, *, empty_ok: bool = False, **kw) -> dict:
        """A call whose success is a 2xx. A lost answer is ``_Lost``; a refusal is a ``PublishStop``."""
        r = self._send(method, url, what, **kw)
        status = getattr(r, "status_code", 0)
        doc = _read_doc(r)
        if status >= 500:
            raise _Lost(f"x {what}: HTTP {status}")  # the work may have been done: not a refusal
        if status >= 300:
            raise x_error(what, r, doc)
        if doc is None:
            if empty_ok and status < 300:
                return {}
            raise _Lost(f"x {what}: HTTP {status}, an answer that is not JSON")
        return doc

    # -- the steps ------------------------------------------------------------------
    def _init(self, tok, size: int) -> str:
        try:
            doc = self._call("post", f"{self.api}/media/upload/initialize", "initialize", headers=self._auth(tok),
                             json={"media_type": MEDIA_TYPE, "total_bytes": size, "media_category": MEDIA_CATEGORY},
                             timeout=60)
        except _Lost as e:
            raise sp.failed("upload_failed", e.detail + " - nothing was posted") from None
        data = doc.get("data")
        media_id = str(data.get("id") or "") if isinstance(data, dict) else ""
        if not _ID.fullmatch(media_id):
            raise sp.failed("platform_error", "x initialize: no usable media id returned")
        return media_id

    def _append(self, tok, media_id: str, path: Path, size: int) -> None:
        index, offset = 0, 0
        with open(path, "rb") as fh:
            while offset < size:
                want = min(self.segment_bytes, size - offset)
                fh.seek(offset)
                chunk = fh.read(want)
                if len(chunk) != want:
                    raise sp.failed("upload_failed", "x append: the file changed while it was being sent")
                self._append_one(tok, media_id, index, chunk)
                self.heartbeat()
                index, offset = index + 1, offset + want

    def _append_one(self, tok, media_id: str, index: int, chunk: bytes) -> None:
        last = ""
        for _ in range(APPEND_TRIES):
            try:
                self._call("post", f"{self.api}/media/upload/{media_id}/append", f"append {index}",
                           headers=self._auth(tok), data={"segment_index": str(index)},
                           files={"media": ("segment", chunk, "application/octet-stream")}, timeout=300,
                           empty_ok=True)
                return
            except _Lost as e:
                last = e.detail
        raise sp.failed("upload_failed", f"{last}; segment {index} did not go through after {APPEND_TRIES} tries")

    def _finalize(self, tok, media_id: str) -> Optional[dict]:
        """The ``processing_info`` X returned, or None when it said the media is ready (or, after a lost answer, the
        STATUS read decides)."""
        try:
            doc = self._call("post", f"{self.api}/media/upload/{media_id}/finalize", "finalize",
                             headers=self._auth(tok), timeout=120)
        except _Lost:
            return self._status(tok, media_id, "finalize read-back", lost_means="upload_failed")
        data = doc.get("data")
        info = data.get("processing_info") if isinstance(data, dict) else None
        return info if isinstance(info, dict) else None

    def _status(self, tok, media_id: str, what: str, lost_means: str = "upload_failed") -> Optional[dict]:
        try:
            doc = self._call("get", f"{self.api}/media/upload", what, headers=self._auth(tok), timeout=30,
                             params={"command": "STATUS", "media_id": media_id})
        except _Lost as e:
            raise sp.failed(lost_means, e.detail) from None
        data = doc.get("data")
        info = data.get("processing_info") if isinstance(data, dict) else None
        return info if isinstance(info, dict) else None

    def _wait_processed(self, tok, media_id: str, info: Optional[dict]) -> None:
        waited, unreadable = 0.0, 0
        while info is not None:
            state = info.get("state")
            if state == "succeeded":
                return
            if state == "failed":
                raise sp.failed("processing_failed", "x processing ended with failed")
            if not isinstance(state, str):
                unreadable += 1
                if unreadable >= MAX_UNREADABLE_POLLS:
                    raise sp.failed("platform_error", "x status: no usable processing state in the answers")
            if waited >= self.max_wait:
                raise sp.failed("timeout", f"x still processing after {int(waited)}s")
            after = _int(info.get("check_after_secs"))
            pause = float(min(max(after, MIN_CHECK_AFTER), MAX_CHECK_AFTER)) if after is not None else self.poll_seconds
            self.heartbeat()
            self.sleep(pause)
            waited += max(pause, 1.0)
            info = self._status(tok, media_id, "status")

    def _post(self, tok, media_id: str, text: str, ai_generated: bool) -> dict:
        body: dict = {"text": text, "media": {"media_ids": [media_id]}}
        if ai_generated:
            # X's self-disclosure of AI media (create-post page, ``made_with_ai``). Sent only when the label is true: an
            # absent field is the unlabelled post every post has always been.
            body["made_with_ai"] = True
        try:
            doc = self._call("post", f"{self.api}/tweets", "post", headers=self._auth(tok), json=body, timeout=60)
        except _Lost as e:
            raise self._unconfirmed(e.detail) from None
        data = doc.get("data")
        post_id = str(data.get("id") or "") if isinstance(data, dict) else ""
        if not _ID.fullmatch(post_id):
            raise self._unconfirmed("x post: the answer named no post")
        return {"result_id": post_id, "result_url": f"https://x.com/i/status/{post_id}", "privacy": None}

    @staticmethod
    def _unconfirmed(detail: str) -> sp.PublishStop:
        return sp.failed(REASON_UNCONFIRMED, f"{detail}; it is not known whether the post exists - check the account's "
                                             "timeline before sending again")

    # -- the whole thing ----------------------------------------------------------------
    def publish(self, tok: social_tokens.SocialToken, path: Path, text: str, ai_generated: bool = False) -> dict:
        if not str(tok.access_token or ""):
            raise sp.refused("account_not_connected", "the connected account has no token")
        try:
            size = Path(path).stat().st_size
        except OSError:
            raise sp.refused("master_not_available", "the video file cannot be read") from None
        if size <= 0 or size > self.max_bytes:
            raise sp.refused("too_large", f"the video is {size / 1048576:.0f} MB; the upload limit here is "
                                          f"{self.max_bytes / 1048576:.0f} MB")
        media_id = self._init(tok, size)
        self._append(tok, media_id, Path(path), size)
        info = self._finalize(tok, media_id)
        self._wait_processed(tok, media_id, info)
        return self._post(tok, media_id, text, ai_generated)


__all__ = ["XVideoAdapter", "x_error", "API", "REASONS"]
