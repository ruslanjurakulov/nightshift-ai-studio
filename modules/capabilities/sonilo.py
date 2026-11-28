"""Sonilo (Sonilo Inc.'s own API): music from words, and music scored to a video.

Sources, all read 2026-11-10: ``platform.sonilo.com/docs`` (introduction, quickstart, errors), the reference pages
``.../docs/api/{text-to-music,video-to-music,get-task,list-services,get-usage}``, ``platform.sonilo.com/openapi.json``
(OpenAPI 3.1), ``platform.sonilo.com/llms-full.txt``, ``platform.sonilo.com/pricing``, the Terms of Service
(``sonilo.com/terms-of-service``, last updated October 2, 2026), the Privacy Policy (``sonilo.com/privacy-policy``, last
updated October 10, 2026) and the licensing help centre (``sonilo.com/help/licensing``, last reviewed 2026-10-01).
docs/research/sonilo-first-party.md has the quotes.

DARK AND REGISTRY-ONLY. The two capabilities this adapter serves (``music``, ``video_music``) are not in the database
(``base.REGISTRY_ONLY_CAPABILITIES``): the two registry entries are not synced, cannot be probed or priced, and no job can
name them. Nothing here was called with a key.

* A task is created with ``POST /v1/text-to-music`` or ``POST /v1/video-to-music`` (``multipart/form-data``) and
  ``mode=async``, which answers ``202 {"task_id", "status": "processing"}``; ``GET /v1/tasks/{task_id}`` answers ``status``
  (processing | succeeded | failed), ``audio[]`` with ``url`` / ``content_type`` / ``file_size`` / ``stream_index`` when it
  succeeded, ``error {code, message}`` (and, in the errors page's example as read 2026-11-10, ``"refunded": true``; not found again when re-checked
  2026-11-11, unconfirmed) when it failed.
* WHY ASYNC, when the vendor's default is a stream: the stream answers the audio inside the submit's own response, so a
  worker that dies mid-stream has paid for a track nobody can fetch again. An async task has an id that is stored before
  the first poll and its file is kept for a while (read 2026-11-10: "A temporary download URL for the audio file, valid
  for 7 days"; not found again when re-checked 2026-11-11, so the 7 days are unconfirmed).
* Authentication is ``Authorization: Bearer sk_...``. The key goes to the API host and nowhere else; no redirect is followed.
* ``Accept-Encoding: identity`` rides every call, and an answer that comes back with another ``Content-Encoding`` is not
  used (at submit that is UNCONFIRMED SPEND, like any other unreadable answer). This does not bound memory: the HTTP
  library has already decoded a non-streamed body by the time the header is read.

What is sent, and why. Everything the price depends on is sent as given, never left to the vendor's default:
``duration`` (text-to-music is billed per second of output; left out, Sonilo infers a length from the prompt, "90 sec only
when it cannot be"), ``variants_num=1`` ("Cost scales linearly"), ``mode=async`` and ``output_format=mp3`` (320 kbps; the
default m4a is a fragmented MP4 whose brand the media library could read as a video). A duration under 10 s is refused:
Sonilo bills "a 4-second text-to-music clip ... as 10 seconds", so a shorter track would cost more than seconds x rate.
Video-to-music takes no duration: the music is as long as the video, and that length is what Sonilo bills (10 s at least,
360 s at most; the database prices the source's seconds, and the floor is its job when a migration makes this sellable).

A VIDEO IS UPLOADED AS BYTES, never as ``video_url``: a link from a job row is not handed to a vendor to fetch. Before
anything is sent the file must be a regular local ``.mp4`` (the one container Sonilo's pages show) of at most 300 MB
("Max file size: default 300MB") whose first bytes are an MP4's ``ftyp`` box and not an audio-only brand. It is sent
under a fixed name, not the uploader's.

NOTHING UPLOADED CAN BE DELETED. The OpenAPI document has one DELETE (``/v1/account/keys/self``, which revokes the calling
key and is never called here) and no route that removes a task or its media. The Privacy Policy says uploaded videos,
prompts and outputs are used for model training "by default to all users, and there is no separate opt-out". Every
customer video sent here stays with Sonilo on those terms.

Not sent: ``video_url``, ``segments``, ``prompt_influence``, ``preserve_speech``, ``ducking``, ``stems`` (each adds result
links this adapter does not read). Not wired, so nobody can reach them: the stream mode, video-to-video, sound effects,
combined sound, audio ducking, video analysis, proofread and dubbing.

RESULT LINKS: no page names a real host (read 2026-11-10: "hosted on Sonilo storage", ``cdn.example.com`` in the
examples; neither found again when re-checked 2026-11-11). ``RESULT_HOSTS`` is therefore EMPTY: every link is refused (fail closed) with the host it names and
the ``SPEND MAY HAVE OCCURRED`` note. The first real probe ends that way; a person reads the host, checks it is Sonilo's,
pins that EXACT host here (never a parent domain other customers' buckets share) and probes again. The first probe's
task is not fetched again by any code path.

BILLING: nothing read says what a failed generation costs. The errors page shows a failed task with ``"refunded": true``;
that is one example, not a rule, and it is quoted as Sonilo's own statement only when a task carries it. The task page
said (2026-11-10; not found again 2026-11-11, unconfirmed) that a task "keeps running and is billed on the server
regardless" of whether anyone polls it; the OpenAPI document has no cancel.

TERMS: ``terms_gate: terms_review_required`` (docs/research/sonilo-first-party.md).
"""

from __future__ import annotations

import json
import logging
import os
import re
import stat
from pathlib import Path
from typing import Dict, List, Optional

from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_NOT_FOUND,
    E_QUOTA,
    E_RATE_LIMITED,
    E_UNAVAILABLE,
    FAILED,
    MUSIC,
    PENDING,
    SUCCEEDED,
    VIDEO_MUSIC,
    AdapterError,
    CapabilityRequest,
    HttpAdapter,
    Output,
    PollResult,
    ProviderTask,
    json_body,
)
from modules.capabilities.safe_fetch import SafeResultMixin, after_completion, unconfirmed

logger = logging.getLogger(__name__)

#: See RESULT LINKS above: no host is known, so none is allowed.
RESULT_HOSTS: tuple = ()
#: No compressed answers are asked for; one that comes anyway is not used.
ACCEPT_IDENTITY = {"Accept-Encoding": "identity"}
#: What is asked for and what the stored file must be: MP3, by its first bytes.
OUTPUT_FORMAT, RESULT_MIME = "mp3", "audio/mpeg"
#: The largest task answer parsed (a task object is a few hundred bytes).
MAX_API_BYTES = 1024 * 1024
#: How many tasks' reported figures are kept in memory.
_KEEP = 64

#: A task id: letters, digits, "-" and "_" only (no "." so ".." cannot walk the path up, no "/", "?" or ":").
_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
#: Said after any task that ended without a result we could trust.
SPEND_UNKNOWN = ("SPEND UNKNOWN: Sonilo's pages do not say what a failed generation costs (its errors page shows one failed "
                 "task marked refunded: a vendor example, unverified here); check the Sonilo usage page before assuming "
                 "nothing was spent")
#: The error ``code`` words Sonilo's pages name -> ours.
_ERRORS = {
    "auth_invalid": E_AUTH, "forbidden": E_AUTH,
    "payment_required": E_QUOTA, "insufficient_balance": E_QUOTA, "trial_exhausted": E_QUOTA,
    "rate_limit_exceeded": E_RATE_LIMITED,
    "not_found": E_NOT_FOUND,
    "unprocessable_entity": E_BAD_REQUEST,
    "upstream_error": E_UNAVAILABLE,
}
#: The words the task page and the OpenAPI document use. ``completed`` and ``canceled`` are not in the schema's enum, but the
#: OpenAPI text of the poll route says "Stop on succeeded/completed/failed/canceled": both are read as what they say.
_DONE = ("succeeded", "completed")
_CANCELLED = ("canceled", "cancelled")
#: The one container Sonilo's pages show for a video upload.
VIDEO_SUFFIXES = (".mp4",)
#: ISO-BMFF brands of a file with sound and no picture: Sonilo answers those 422 ("no video track").
_AUDIO_BRANDS = (b"M4A ", b"M4B ", b"M4P ", b"F4A ", b"F4B ")
#: The name a video is uploaded under: never the uploader's file name.
UPLOAD_NAME = "source.mp4"


def read_video(path_str: str, *, max_bytes: int) -> bytes:
    """The bytes of a LOCAL MP4 video, only if its suffix is ``.mp4``, it is a regular file of at most ``max_bytes`` and its
    first bytes are an MP4's ``ftyp`` box with a brand that is not audio-only. The path comes from a job: a ``.mp4`` that is
    really a document or a secrets file must never be POSTed to a vendor. Nothing has been sent when it raises."""
    path = Path(path_str)
    if path.suffix.lower() not in VIDEO_SUFFIXES:
        raise AdapterError(E_BAD_REQUEST, "Sonilo is sent MP4 video only", not_accepted=True)
    over = AdapterError(E_BAD_REQUEST, f"the video is over {max_bytes // (1 << 20)} MB", not_accepted=True)
    fd = None
    try:
        # One open, decided on that descriptor (as pictures.read_picture does): O_NONBLOCK so a FIFO named x.mp4 cannot
        # block the open, fstat so a device or a FIFO is refused before a byte is read, the size checked BEFORE the read,
        # and a read of at most max_bytes + 1 so a file that grew after the check is still stopped at the cap.
        fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0))
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise AdapterError(E_BAD_REQUEST, "the video is not a regular file", not_accepted=True)
        if info.st_size > max_bytes:
            raise over
        with os.fdopen(fd, "rb") as fh:
            fd = None
            data = fh.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise over
    except OSError:
        raise AdapterError(E_BAD_REQUEST, "the video could not be read", not_accepted=True) from None
    finally:
        if fd is not None:
            os.close(fd)
    if len(data) < 12 or data[4:8] != b"ftyp":
        raise AdapterError(E_BAD_REQUEST, "the file is not an MP4 video; it was not sent", not_accepted=True)
    if data[8:12] in _AUDIO_BRANDS:
        raise AdapterError(E_BAD_REQUEST, "the file is an audio-only MP4, not a video; it was not sent", not_accepted=True)
    return data


class SoniloMusicAdapter(SafeResultMixin, HttpAdapter):
    """Sonilo text-to-music and video-to-music, as async tasks that end in one MP3."""

    key = "audio.sonilo"
    key_env = ("SONILO_API_KEY",)
    base_url_env = "SONILO_BASE_URL"
    default_base_url = "https://api.sonilo.com"
    capabilities = (MUSIC, VIDEO_MUSIC)
    result_hosts = RESULT_HOSTS
    #: The key rides every call in an ``Authorization`` header: a 3xx is an error, never followed.
    follow_redirects = False
    timeout = 60
    #: The upload answers only after Sonilo has taken (and measured) the whole video.
    upload_timeout = 600
    #: Six minutes of 320 kbps MP3 is under 15 MB; nothing near this is a track.
    max_result_bytes = 64 * 1024 * 1024
    #: "Max file size: default 300MB" (the account's own figure is ``max_upload_size_mb`` of GET /v1/account/services).
    MAX_VIDEO_BYTES = 300 * 1024 * 1024
    #: Seconds a text-to-music track may be asked for. Sonilo takes 5 to 360 and bills at least 10: see the module note.
    MIN_SECONDS, MAX_SECONDS = 10, 360
    #: vendor model (the endpoint: Sonilo's API has no model field) -> the capability it serves. This is the whole list.
    SPECS = {"text-to-music": MUSIC, "video-to-music": VIDEO_MUSIC}

    def __init__(self, **kw):
        super().__init__(**kw)
        #: task id -> (duration_seconds, number of audio streams) as Sonilo's task reported them; for ``probe_note``.
        self.reported: Dict[str, tuple] = {}
        #: Status words this adapter does not know, counted.
        self.unknown_statuses: Dict[str, int] = {}

    # -- HTTP ------------------------------------------------------------------
    def _call(self, method: str, url: str, *, what: str, headers=None, raw: bool = False, **kw):
        resp = super()._call(method, url, what=what, headers={**(headers or {}), **ACCEPT_IDENTITY}, raw=True, **kw)
        coding = str((getattr(resp, "headers", None) or {}).get("Content-Encoding") or "").strip().lower()
        if coding and coding != "identity":
            # Not asked for, so not trusted: it is not parsed. At submit ``submit_json`` turns this into UNCONFIRMED SPEND.
            raise AdapterError(E_BAD_RESPONSE, f"{what}: the answer came with a Content-Encoding although none was asked "
                                               f"for; it was not used")
        if raw:
            return resp
        body = getattr(resp, "content", b"") or b""
        if len(body) > MAX_API_BYTES:
            raise AdapterError(E_BAD_RESPONSE, f"{what}: the answer is over {MAX_API_BYTES} bytes; it was not read")
        try:
            return json.loads(body)
        except ValueError:
            raise AdapterError(E_BAD_RESPONSE, f"{what}: response is not JSON") from None

    def vendor_error_code(self, status: int, text: str) -> Optional[str]:
        # Never for a 5xx: a gateway can answer 502 / 503 / 504 in front of a Sonilo that already took the task, and a vendor
        # word ("rate_limit_exceeded") must not turn that into a refusal. The status decides, so it stays unconfirmed.
        if status >= 500:
            return None
        return _ERRORS.get(str(json_body(text).get("code") or ""))

    # -- request validation --------------------------------------------------------
    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        cap = self.SPECS.get(vendor_model)
        if cap is None:
            return [f"{vendor_model!r} is not a Sonilo endpoint this adapter knows"]
        if request.capability != cap:
            return [f"{vendor_model} does not do {request.capability}"]
        out: List[str] = []
        if request.negative_prompt:
            out.append("Sonilo takes no negative prompt")
        if request.input_images or request.end_image:
            out.append("a picture does not apply to music")
        if request.text_language is not None:
            # BR-L-209: the bridge passes a music job's language since Lyria (creative_adapters.capability_request). Sonilo has no
            # language field, so a language sent here would be paid for and ignored (rule 4): refused instead.
            out.append("Sonilo has no language setting: a sung language is refused, not ignored")
        d = request.duration_s
        if cap == MUSIC:
            if not request.prompt.strip():
                out.append("prompt is empty")
            if request.input_media:
                out.append("a video does not apply to text-to-music")
            if isinstance(d, bool) or not isinstance(d, int) or not self.MIN_SECONDS <= d <= self.MAX_SECONDS:
                out.append(f"duration {d if d is not None else '(none)'} s is not offered ({self.MIN_SECONDS} to "
                           f"{self.MAX_SECONDS}): the price is per second and Sonilo bills at least {self.MIN_SECONDS} s, so "
                           f"it is never defaulted")
        else:
            if len(request.input_media) != 1:
                out.append("exactly one video is required")
            elif "://" in str(request.input_media[0]):
                out.append("a video must be a local file, not a link: the worker hands over files, and no link is given to a "
                           "vendor to fetch")
            if d is not None:
                out.append("a duration does not apply: the music is as long as the video")
        return out

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        out.extend(self._spec_problems(request, entry.vendor_model_for(request.capability)))
        return out

    # -- the protocol --------------------------------------------------------------
    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        bad = self._spec_problems(request, vendor_model)
        if bad:
            # Nothing has been sent: this is a refusal, not a lost answer.
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad), not_accepted=True)
        # Multipart text fields the way Sonilo's own examples send them: (None, value). The three fixed ones pin what is
        # billed and how it comes back, whatever the vendor's defaults become.
        fields: dict = {"mode": (None, "async"), "output_format": (None, OUTPUT_FORMAT), "variants_num": (None, "1")}
        prompt = request.prompt.strip()
        if prompt:
            fields["prompt"] = (None, prompt)
        timeout = self.timeout
        if self.SPECS[vendor_model] == MUSIC:
            fields["duration"] = (None, str(int(request.duration_s)))
        else:
            # Read and checked BEFORE anything is sent: a refused file sends nothing at all.
            fields["video"] = (UPLOAD_NAME, read_video(str(request.input_media[0]), max_bytes=self.MAX_VIDEO_BYTES), "video/mp4")
            timeout = self.upload_timeout
        data = self.submit_json(f"{self.base_url}/v1/{vendor_model}", None, files=fields, timeout=timeout)
        tid = data.get("task_id") if isinstance(data, dict) else None
        if not isinstance(tid, str) or not _ID.fullmatch(tid):
            # The vendor answered 2xx: a task probably exists, and it bills whether or not anyone polls it.
            raise unconfirmed("the answer carries no usable task_id")
        return ProviderTask(self.key, vendor_model, tid)

    def probe_note(self, task: ProviderTask) -> str:
        """What the probe prints beside OK: the length Sonilo reported, to compare with seconds x the registry estimate."""
        seen = self.reported.get(str(task.task_id or ""))
        if not seen:
            return "Sonilo reported no duration"
        seconds, streams = seen
        return (f"Sonilo reported duration_seconds {seconds if seconds is not None else '(none)'} and {streams} audio "
                f"stream(s); one was stored (compare seconds x the registry rate, 10 s at least, with the usage page)")

    def _remember(self, tid: str, value: tuple) -> None:
        self.reported[tid] = value
        while len(self.reported) > _KEEP:
            self.reported.pop(next(iter(self.reported)))

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        tid = str(task.task_id or "")
        if not _ID.fullmatch(tid):
            raise AdapterError(E_NOT_FOUND, "task id has an unexpected shape")
        data = self.get(f"{self.base_url}/v1/tasks/{tid}")
        data = data if isinstance(data, dict) else {}
        raw_status = data.get("status")
        status = raw_status.lower() if isinstance(raw_status, str) else None
        if status == "processing":
            return PollResult(PENDING)
        if status in _DONE:
            audio = data.get("audio")
            streams = [a for a in (audio if isinstance(audio, list) else [audio])
                       if isinstance(a, dict) and isinstance(a.get("url"), str) and a["url"]]
            if not streams:
                # The vendor says the track exists (and bills it): we just were not given the link.
                raise after_completion(AdapterError(E_BAD_RESPONSE, "succeeded without audio[].url"))
            # One variant was asked for; when Sonilo still answers several parallel streams, the first is the track.
            pick = next((a for a in streams if type(a.get("stream_index")) is int and a["stream_index"] == 0), streams[0])
            seconds = data.get("duration_seconds")
            seconds = seconds if isinstance(seconds, (int, float)) and not isinstance(seconds, bool) else None
            self._remember(tid, (seconds, len(streams)))
            size = pick.get("file_size")
            if type(size) is int and size > self.max_result_bytes:
                raise after_completion(AdapterError(
                    E_BAD_RESPONSE, f"the task reports a {size} byte file, over the {self.max_result_bytes} byte limit; "
                                    f"not downloaded"))
            return self.checked_outputs(PollResult(SUCCEEDED, [Output(RESULT_MIME, url=pick["url"])]))
        if status == "failed":
            err = data.get("error") if isinstance(data.get("error"), dict) else {}
            code = str(err.get("code") or "")
            text = self.message(err.get("message") or code or "the task failed")
            said = " Sonilo's task record says refunded (its statement, unverified)." if data.get("refunded") is True else ""
            return PollResult(FAILED, error=AdapterError(_ERRORS.get(code, E_UNAVAILABLE), f"{text}.{said} {SPEND_UNKNOWN}"))
        if status in _CANCELLED:
            return PollResult(FAILED, error=AdapterError(
                E_UNAVAILABLE, f"the task was cancelled at Sonilo and will not finish. {SPEND_UNKNOWN}"))
        # Anything else (expired, queued, an empty or non-text status) is not a word the pages list: a task that will not
        # finish as documented is a failure, never a task still running, and what it cost is not known.
        if isinstance(raw_status, str):
            word = self.message(raw_status)[:40] or "(none)"
        else:
            word = "(none)" if raw_status is None else "(not text)"
        self.unknown_statuses[word] = self.unknown_statuses.get(word, 0) + 1
        logger.warning("sonilo: task status %r is not one the pages list; treated as a failure", word)
        return PollResult(FAILED, error=AdapterError(
            E_UNAVAILABLE, f"Sonilo reported a task status this adapter does not know ({word}). {SPEND_UNKNOWN}"))


ADAPTERS = (SoniloMusicAdapter,)
