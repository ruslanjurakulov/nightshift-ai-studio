"""Facebook Reels on a Page (Graph API) - the adapter behind ``social_publish.FacebookPublisher``. DARK.

Nothing can reach this code today: ``social_accounts`` / ``publish_requests`` (0028 / 0029) do not allow the word
``facebook``, there is no connect flow and there is no Meta app. It exists so the day the owner has an app (and
Meta's review) the adapter is already written, tested against a loopback fake and reviewed.

Flow (official page, read 2026-10-25: https://developers.facebook.com/docs/video-api/guides/reels-publishing):

1. ``POST graph.facebook.com/{v}/{page-id}/video_reels`` ``upload_phase=start`` -> ``video_id`` + ``upload_url``
   (``https://rupload.facebook.com/video-upload/{video-id}``);
2. ``POST`` the bytes to that URL (``Authorization: OAuth <token>``, ``offset``, ``file_size``,
   ``Content-Type: application/octet-stream``). An interrupted upload is RESUMED: ``GET /{video-id}?fields=status``
   says ``uploading_phase.bytes_transfered`` and the next POST starts at that ``offset`` (at most ``MAX_RESUMES``);
3. ``GET /{video-id}?fields=status`` until ``video_status`` is ``ready``;
4. ``POST .../video_reels`` ``upload_phase=finish`` ``video_state=DRAFT`` ``description`` and, only when the AI
   decision is true, ``is_ai_generated=true``.

What this module holds to, and why (each has a test in tests/test_social_facebook.py):

* **The token goes to two fixed hosts and nowhere else.** ``upload_url`` comes out of a JSON body we do not control.
  It is accepted only when ``checked_polling_url`` (modules/capabilities/safe_fetch.py, the strict check written after
  the BFL polling-link bug) says it is https on ``rupload.facebook.com`` and its path is ``/video-upload/.../{video-id}``;
  otherwise the token is not sent and the request fails. No redirect is followed anywhere (a 3xx is a failure), the
  token travels in the ``Authorization`` header only (never a URL: a ``requests`` error message would print it), and
  no body, header or exception text of the platform is copied into an error or a log line: only our own words, an HTTP
  status, Meta's numeric error code / subcode and the type name of an exception.
* **Hard byte cap.** The file must be within ``FB_MAX_BYTES`` before anything is sent, is measured again right before
  the upload, and the body stream never yields more than ``file_size - offset`` bytes (a file that grows while it
  is read is cut, the platform sees a short body and the status poll says so). API answers are read through a 1 MiB cap.
* **A publish is never retried.** Only ``finish`` makes the Reel exist as the post. If its answer is lost (timeout,
  dropped connection, 5xx, a 2xx that is not ``{"success": true}``) the adapter READS the video back once
  (``publishing_phase.publish_status``): ``draft`` / ``scheduled`` / ``published`` = it happened and is recorded as such;
  ``error`` = failed; anything else (including a read-back that itself fails) = ``publish_unconfirmed``: the request
  ends FAILED with that word and the sentence "check the Page before sending again", and nothing ever sends a second
  ``finish``. A stale ``processing`` row is failed as ``interrupted`` by the queue (0029), never re-queued, so a worker
  that dies after ``finish`` is the same case. A lost answer on ``start`` or on the upload leaves a harmless unfinished
  upload session (Meta expires it); a new request starts a new session, so it cannot post twice.
* **DRAFT, not PUBLISHED.** Facebook is the one Meta surface with a state that is private until a person acts, so the
  Reel is saved as a draft on the Page (the owner publishes it in Meta Business Suite), the same rule as YouTube
  ``private`` and TikTok ``SELF_ONLY`` (CLAUDE.md #2). ``FB_VIDEO_STATE`` is a constant, not a switch: changing it is a
  code change and the owner's decision.
* **No pricing.** Uploading costs nothing; no credits are held.

Rate limits and quota (clear messages, no counting of our own): Meta allows 30 API-published Reels per Page per rolling
24 h on this endpoint and enforces it; the Page call budget is ``4800 x engaged users`` per 24 h. Error codes 4, 17, 32,
613 and 80000-80014 are ``rate_limited`` (with Meta's own ``estimated_time_to_regain_access`` from
``X-Business-Use-Case-Usage`` when it sends one, in whole minutes). A local counter would need a database table.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Callable, Iterator, Optional, Sequence
from urllib.parse import urlsplit

from modules import social_probe
from modules import social_publish as sp
from modules import social_tokens
from modules.capabilities.base import AdapterError
from modules.capabilities.safe_fetch import checked_polling_url

#: Graph version of the official page's examples (it also shows v18.0 in places). A live probe confirms it.
GRAPH_VERSION = "v26.0"
GRAPH = f"https://graph.facebook.com/{GRAPH_VERSION}"
RUPLOAD_HOST = "rupload.facebook.com"
PORTS = (None, 443)

#: Saved on the Page as a draft; a person publishes it. See the module docstring.
FB_VIDEO_STATE = "DRAFT"

MAX_RESUMES = 3
MAX_API_BODY = 1024 * 1024
UPLOAD_BLOCK = 1024 * 1024
MAX_UNREADABLE_POLLS = 3

#: The closed words this module adds to ``publish_requests.reason`` (sentences in en / ru / uz: command-center/lib/publish.ts).
REASON_UNCONFIRMED = "publish_unconfirmed"
REASON_PERMISSION = "permission_missing"
REASONS = (REASON_UNCONFIRMED, REASON_PERMISSION, social_probe.REASON_TOO_SMALL)

_ID = re.compile(r"[0-9]{1,30}")
_WORD = re.compile(r"[A-Za-z0-9_]{1,64}")

_RATE_CODES = {4, 17, 32, 613} | set(range(80000, 80015))
_AUTH_CODES = {190, 102}
_PERMISSION_CODES = {10} | set(range(200, 300))
#: Meta's own codes for a file it will not take (reels-publishing "Error Codes"), found in ``code`` or ``error_subcode``.
_FILE_CODES = {1363040: "bad_aspect", 1363127: social_probe.REASON_TOO_SMALL, 1363129: "bad_framerate"}
_REDIRECTS = (301, 302, 303, 307, 308)


class _Lost(Exception):
    """The request left, and the answer did not come back (or was unusable): the outcome is not known."""

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


class _Slice:
    """The file from ``offset`` to ``end`` as a request body of known length, never longer than that.

    ``requests`` / urllib3 read ``__len__`` for Content-Length and then call ``read`` until it returns ``b""``; the body
    stops at ``end`` even when the file has grown since it was measured, so the cap holds for what is really sent. A file
    that shrank yields fewer bytes (the platform sees a short body and its status says so)."""

    def __init__(self, path: Path, offset: int, end: int):
        self.path, self.offset, self.end = path, offset, end
        self._fh = None
        self._left = end - offset

    def __len__(self) -> int:
        return self.end - self.offset

    def read(self, n: int = -1) -> bytes:
        if self._left <= 0:
            self.close()
            return b""
        if self._fh is None:
            self._fh = open(self.path, "rb")
            self._fh.seek(self.offset)
        want = self._left if n is None or n < 0 else min(n, self._left, UPLOAD_BLOCK)
        block = self._fh.read(want)
        if not block:
            self._left = 0
            self.close()
            return b""
        self._left -= len(block)
        return block

    def __iter__(self) -> Iterator[bytes]:
        while True:
            block = self.read(UPLOAD_BLOCK)
            if not block:
                return
            yield block

    def close(self) -> None:
        if self._fh is not None:
            try:
                self._fh.close()
            finally:
                self._fh = None


def _read_doc(r) -> Optional[dict]:
    """The JSON object of an answer, read through a size cap; None when it is not one."""
    declared = 0
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


def _close(r) -> None:
    try:
        r.close()
    except Exception:
        pass


def _int(v) -> Optional[int]:
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _regain_minutes(r) -> Optional[int]:
    """Meta's ``estimated_time_to_regain_access`` (minutes) from ``X-Business-Use-Case-Usage``, when it sends one."""
    try:
        raw = (getattr(r, "headers", None) or {}).get("X-Business-Use-Case-Usage")
        doc = json.loads(raw) if isinstance(raw, str) and len(raw) <= 8192 else None
        best = None
        for entries in (doc.values() if isinstance(doc, dict) else ()):
            for e in (entries if isinstance(entries, list) else ()):
                m = _int(e.get("estimated_time_to_regain_access")) if isinstance(e, dict) else None
                if m is not None and 0 < m <= 7 * 24 * 60:
                    best = m if best is None else max(best, m)
        return best
    except Exception:
        return None


def graph_error(what: str, r, doc: Optional[dict]) -> sp.PublishStop:
    """A refused request as a closed reason word plus our own detail (status, Meta's numeric code / subcode, and for the
    upload host its ``debug_info.type`` word). Never Meta's message text."""
    err = (doc or {}).get("error") if isinstance(doc, dict) else None
    err = err if isinstance(err, dict) else {}
    code, sub = _int(err.get("code")), _int(err.get("error_subcode"))
    status = getattr(r, "status_code", 0)
    parts = [f"HTTP {status}"]
    if code is not None:
        parts.append(f"code {code}")
    if sub is not None:
        parts.append(f"subcode {sub}")
    dbg = (doc or {}).get("debug_info") if isinstance(doc, dict) else None
    kind = dbg.get("type") if isinstance(dbg, dict) else None
    kind = kind if isinstance(kind, str) and _WORD.fullmatch(kind) else None
    if kind:
        parts.append(kind)
    detail = f"facebook {what}: {', '.join(parts)}"
    if code in _AUTH_CODES or status == 401:
        return sp.failed("token_expired", detail + " - reconnect the Page")
    if code in _PERMISSION_CODES:
        return sp.failed(REASON_PERMISSION, detail + " - reconnect the Page and allow posting")
    if code in _RATE_CODES or status == 429:
        wait = _regain_minutes(r)
        return sp.failed("rate_limited", detail + (f" - Meta says to retry in about {wait} min" if wait else ""))
    for n in (code, sub):
        if n in _FILE_CODES:
            return sp.failed(_FILE_CODES[n], detail)
    if kind == "ProcessingFailedError":
        return sp.failed("processing_failed", detail)
    return sp.failed("platform_error", detail)


class FacebookReelsAdapter:
    """``publish`` returns ``{"result_id": video id, "result_url": None, "privacy": what Meta reports}`` or raises
    ``sp.PublishStop``. ``graph`` / ``rupload_host`` / ``ports`` are for the loopback tests; the defaults are the
    official hosts, and nothing reads them from the environment."""

    def __init__(self, http, *, sleep: Callable[[float], None] = time.sleep,
                 heartbeat: Callable[[], None] = lambda: None, poll_seconds: float = sp.POLL_SECONDS,
                 max_wait: float = sp.MAX_WAIT_SECONDS, graph: str = GRAPH, rupload_host: str = RUPLOAD_HOST,
                 ports: Sequence[Optional[int]] = PORTS, max_bytes: int = sp.FB_MAX_BYTES):
        self.http, self.sleep, self.heartbeat = http, sleep, heartbeat
        self.poll_seconds, self.max_wait = poll_seconds, max_wait
        self.graph, self.rupload_host, self.ports, self.max_bytes = graph.rstrip("/"), rupload_host, tuple(ports), max_bytes

    # -- one HTTP call ------------------------------------------------------------
    @staticmethod
    def _auth(tok) -> dict:
        return {"Authorization": f"OAuth {tok.access_token}"}

    def _send(self, method: str, url: str, what: str, **kw):
        """The response, or ``_Lost`` when it did not come. No redirect is followed; a 3xx is a failure."""
        try:
            r = getattr(self.http, method)(url, allow_redirects=False, stream=True, **kw)
        except Exception as e:  # network, TLS, timeout: the type only, never the message (it can carry the URL)
            raise _Lost(f"facebook {what}: {type(e).__name__}") from None
        status = getattr(r, "status_code", 0)
        if status in _REDIRECTS:
            _close(r)
            raise sp.failed("platform_error", f"facebook {what}: HTTP {status} - a redirect is never followed")
        return r

    def _call(self, method: str, url: str, what: str, **kw) -> dict:
        """A call whose success is a 2xx JSON object. A lost answer is ``_Lost``."""
        r = self._send(method, url, what, **kw)
        status = getattr(r, "status_code", 0)
        doc = _read_doc(r)
        if status >= 500:
            raise _Lost(f"facebook {what}: HTTP {status}")  # the work may have been done: not a refusal
        if status >= 300:
            raise graph_error(what, r, doc)
        if doc is None:
            raise _Lost(f"facebook {what}: HTTP {status}, an answer that is not JSON")
        return doc

    # -- the steps ------------------------------------------------------------------
    def _start(self, tok, page: str) -> tuple:
        try:
            doc = self._call("post", f"{self.graph}/{page}/video_reels", "start", json={"upload_phase": "start"},
                             headers=self._auth(tok), timeout=60)
        except _Lost as e:
            raise sp.failed("upload_failed", e.detail + " - nothing was posted") from None
        video_id = str(doc.get("video_id") or "")
        if not _ID.fullmatch(video_id):
            raise sp.failed("platform_error", "facebook start: no usable video id returned")
        url = doc.get("upload_url")
        try:
            url = checked_polling_url(url, self.rupload_host, self.ports)
        except AdapterError:
            raise sp.failed("platform_error", f"facebook start: the upload address is not on {self.rupload_host}; "
                                              "the token was not sent to it") from None
        path = urlsplit(url).path
        if not (path.startswith("/video-upload/") and path.rstrip("/").endswith("/" + video_id)):
            raise sp.failed("platform_error", "facebook start: the upload address does not name the video; "
                                              "the token was not sent to it")
        return video_id, url

    def _status(self, tok, video_id: str, what: str) -> Optional[dict]:
        """The ``status`` object of the video, or None when the answer had no usable one."""
        doc = self._call("get", f"{self.graph}/{video_id}", what, params={"fields": "status"},
                         headers=self._auth(tok), timeout=30)
        st = doc.get("status")
        return st if isinstance(st, dict) else None

    def _post_bytes(self, tok, url: str, path: Path, offset: int, size: int) -> bool:
        """One upload request from ``offset``; True when Meta answered ``success``. A lost answer is False."""
        headers = {**self._auth(tok), "offset": str(offset), "file_size": str(size),
                   "Content-Type": "application/octet-stream"}
        try:
            r = self._send("post", url, "upload", headers=headers, data=_Slice(path, offset, size), timeout=600)
        except _Lost:
            return False
        status = getattr(r, "status_code", 0)
        doc = _read_doc(r)
        if 400 <= status < 500:
            dbg = doc.get("debug_info") if isinstance(doc, dict) else None
            kind = dbg.get("type") if isinstance(dbg, dict) else None
            if kind in ("OffsetInvalidError", "PartialRequestError"):
                return False  # resumable: the status poll says where to continue
            raise graph_error("upload", r, doc)
        return status < 300 and isinstance(doc, dict) and doc.get("success") is True

    def _upload(self, tok, url: str, video_id: str, path: Path, size: int) -> None:
        offset = 0
        for _ in range(1 + MAX_RESUMES):
            if self._post_bytes(tok, url, path, offset, size):
                return
            self.heartbeat()
            try:
                st = self._status(tok, video_id, "upload status")
            except _Lost as e:
                raise sp.failed("upload_failed", e.detail) from None
            phase = (st or {}).get("uploading_phase")
            got = _int(phase.get("bytes_transfered")) if isinstance(phase, dict) else None
            if got is None or not 0 <= got <= size:
                raise sp.failed("upload_failed", "facebook upload: the upload was interrupted and Meta did not say "
                                                 "how far it got")
            if got == size:
                return
            offset = got
        raise sp.failed("upload_failed", f"facebook upload: still incomplete after {MAX_RESUMES} resumes")

    def _wait_ready(self, tok, video_id: str) -> None:
        waited, unreadable = 0.0, 0
        while True:
            try:
                st = self._status(tok, video_id, "status")
            except _Lost as e:
                raise sp.failed("upload_failed", e.detail) from None
            vs = st.get("video_status") if isinstance(st, dict) else None
            if vs == "ready":
                return
            phase = st.get("processing_phase") if isinstance(st, dict) else None
            if vs in ("upload_failed", "expired"):
                raise sp.failed("upload_failed", f"facebook upload ended with {vs}")
            if vs == "error" or (isinstance(phase, dict) and phase.get("status") == "error"):
                raise sp.failed("processing_failed", "facebook processing ended with an error")
            if not isinstance(vs, str):
                unreadable += 1
                if unreadable >= MAX_UNREADABLE_POLLS:
                    raise sp.failed("platform_error", "facebook status: no usable status in the answers")
            if waited >= self.max_wait:
                raise sp.failed("timeout", f"facebook still processing after {int(waited)}s")
            self.heartbeat()
            self.sleep(self.poll_seconds)
            waited += max(self.poll_seconds, 1.0)   # a zero poll interval must still end at max_wait

    def _finish(self, tok, page: str, video_id: str, caption: str, ai_generated: bool) -> dict:
        body = {"upload_phase": "finish", "video_id": video_id, "video_state": FB_VIDEO_STATE, "description": caption}
        if ai_generated:
            # Meta's self-disclosure of AI use on a Reel. Sent only when the label is true: an absent field is the
            # unlabelled post every Reel has always been.
            body["is_ai_generated"] = True
        lost = ""
        try:
            doc = self._call("post", f"{self.graph}/{page}/video_reels", "publish", json=body,
                             headers=self._auth(tok), timeout=60)
            if doc.get("success") is not True:
                lost = "facebook publish: HTTP 2xx without success"
        except _Lost as e:
            lost = e.detail
        # ONE read-back (a GET); no second finish is ever sent, whatever it says.
        try:
            st = self._status(tok, video_id, "publish read-back")
        except (_Lost, sp.PublishStop):
            st = None
        phase = st.get("publishing_phase") if isinstance(st, dict) else None
        published = phase.get("publish_status") if isinstance(phase, dict) else None
        if published in ("draft", "scheduled", "published"):
            return {"result_id": video_id, "result_url": None, "privacy": published.upper()}
        if published == "error" or (isinstance(phase, dict) and phase.get("status") == "error"):
            raise sp.failed("platform_error", "facebook publish: Meta reports the publishing step as an error")
        if not lost:
            # Meta said success and the read-back could not confirm the state: recorded as it is, privacy unknown.
            return {"result_id": video_id, "result_url": None, "privacy": None}
        raise sp.failed(REASON_UNCONFIRMED, f"{lost}; it is not known whether video {video_id} was saved on the Page "
                                            "- check the Page's drafts before sending again")

    # -- the whole thing ----------------------------------------------------------------
    def publish(self, tok: social_tokens.SocialToken, path: Path, caption: str, ai_generated: bool = False) -> dict:
        page = str(tok.external_id or "")
        if not _ID.fullmatch(page):
            raise sp.refused("account_not_connected", "the connected account has no usable Facebook Page id")
        try:
            size = Path(path).stat().st_size
        except OSError:
            raise sp.refused("master_not_available", "the video file cannot be read") from None
        if size <= 0 or size > self.max_bytes:
            raise sp.refused("too_large", f"the video is {size / 1048576:.0f} MB; the upload limit here is "
                                          f"{self.max_bytes / 1048576:.0f} MB")
        video_id, url = self._start(tok, page)
        self._upload(tok, url, video_id, Path(path), size)
        self._wait_ready(tok, video_id)
        return self._finish(tok, page, video_id, caption, ai_generated)


__all__ = ["FacebookReelsAdapter", "graph_error", "GRAPH", "GRAPH_VERSION", "FB_VIDEO_STATE", "REASONS"]
