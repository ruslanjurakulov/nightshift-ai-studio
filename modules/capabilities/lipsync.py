"""Lip-sync (docs/studio/S6_GAPS.md G6, docs/research/kling-lipsync.md): one face in a video, moved to our own speech file.

REGISTRY-ONLY. ``lipsync`` is in ``base.REGISTRY_ONLY_CAPABILITIES``: the database's capability lists do not hold it, so the
``kling-lipsync`` entry is not synced, not probed, has no credit price, and no job can start it. It exists in the file and here,
and nowhere else, until a migration teaches ``model_registry`` the capability. Its price is unconfirmed and its terms gate open.

``video.kling_lipsync`` — Kling's advanced lip-sync, two calls (Kling's markdown API pages, read 2026-11-22):

1. ``POST /v1/videos/identify-face`` with ``video_url``. **Billed** (Face Recognition, per call), whatever it finds. Answers
   ``data.session_id`` and ``data.face_data[]`` (``face_id``, ``start_time`` / ``end_time`` in ms).
2. ``POST /v1/videos/advanced-lip-sync`` with that ``session_id`` and ``face_choose[]``: one item, our ``sound_file`` (a signed
   https link) and its ``sound_start_time`` / ``sound_end_time`` / ``sound_insert_time`` in ms. Answers ``data.task_id``.
3. ``GET /v1/videos/advanced-lip-sync/{task_id}``: ``task_status`` submitted / processing / succeed / failed
   (``task_status_msg``); the clip is ``task_result.videos[].url``.

What this adapter refuses, and why:

* **Before any call**, an input outside the vendor's limits (the registry entry's ``lipsync`` block says the same numbers): the
  face check is billed even for a file Kling then refuses, so the worker's own measurements (``CapabilityRequest.input_media_facts``
  / ``input_audio_facts``) decide first. A request without measurements is refused, never sent on trust.
* **One face, never a guess.** Kling "currently only supports one person lip-sync". When the request names no ``face_id`` the
  check must find exactly one; zero or several fail (``NO_FACE`` / ``SEVERAL_FACES``) with no lip-sync call. Picking one of two
  faces would move the wrong mouth in a film nobody re-watches before it is shown (CLAUDE.md #4).
* **The speech is ours.** Kling's own TTS (``audio_id``) speaks only zh and en; it is never sent. ``sound_file`` always is.
* **No watermark field** (docs/AI_DISCLOSURE.md, "Vendor watermarks and provenance"): Kling's mark is optional (``watermark_info``
  asks for a second, marked copy) and no clause requires it, so nothing is sent and the default ``url`` is stored byte for byte.
* **Auth** is the console API key as ``Authorization: Bearer`` (Kling's authentication page: the access-key/secret JWT is "only
  applicable to legacy version design standards"). A ``KLING_API_KEY`` written as ``<access>:<secret>`` is not configured.

The task id is ``<session_id>/<face_id>/<task_id>``. The caller persists it BEFORE polling (as every async adapter's caller does), so
a crash polls the paid task instead of paying for a face check and a lip-sync again, and the face that was moved survives the crash
for the provenance below (``parse_task_id``). A crash BETWEEN the two calls loses only the session, so the worst a retry repeats is
one face check, never a lip-sync. Kling deletes the result "after 30 days": the caller fetches it straight after success and stores
the copy; the vendor link is never what a project points at.

Provenance of the stored clip (docs/studio/S6_GAPS.md §4; written by the worker, S2, not here). It is a replacement result for a
clip take, not a new track, and carries::

    {"lipsync_of_asset_id": "<clip>", "dialogue_asset_id": "<dialogue>", "face_id": "<Kling's face_id>", "model": "kling-lipsync"}

``face_id`` is the one this adapter moved (the request's, or the single face found): the middle part of the task id.

Field names are from Kling's pages, pinned by tests/test_kling_lipsync_adapter.py with a fake HTTP layer. No live call has been
made: the first probe the owner approves confirms them before anything is sold.
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional, Sequence, Tuple

from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    LIPSYNC,
    PENDING,
    SUCCEEDED,
    AdapterError,
    CapabilityRequest,
    MediaFacts,
    Output,
    PollResult,
    ProviderTask,
    dig,
    is_url,
)
from modules.capabilities.character_swap import KlingOmniEditAdapter
from modules.capabilities.safe_fetch import after_completion, unconfirmed
from modules.capabilities.video import _failed

_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_FACE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# ── Kling's documented input limits (lip-sync.md and face-detection.md, read 2026-11-22) ─────────────────────────────────
#: "MB" read as 10^6 bytes: the stricter of the two readings, because a file Kling refuses after the face check was still billed.
VIDEO_FORMATS = ("mp4", "mov")
VIDEO_MAX_BYTES = 100_000_000
VIDEO_SECONDS = (2, 60)
#: "720p/1080p" read as the frame's short side; "each side 512-2160 px" as stated.
VIDEO_SHORT_SIDES_PX = (720, 1080)
VIDEO_MIN_SIDE_PX, VIDEO_MAX_SIDE_PX = 512, 2160
AUDIO_FORMATS = ("mp3", "wav", "m4a", "aac")
AUDIO_MAX_BYTES = 5_000_000
AUDIO_SECONDS = (2, 60)
#: The speech crop must be at least 2 s and overlap the chosen face's interval by at least 2 s.
MIN_OVERLAP_MS = 2000

# ── closed reasons (first word of a bad_request message after the billed face check) ────────────────────────────────────
NO_FACE = "no_face"
SEVERAL_FACES = "several_faces"
FACE_NOT_FOUND = "face_not_found"
FACE_OVERLAP = "face_overlap"
REASONS = (NO_FACE, SEVERAL_FACES, FACE_NOT_FOUND, FACE_OVERLAP)

#: Kling's task states. Anything else fails closed: a word we do not know is not "still running".
_RUNNING = ("submitted", "processing")


def _ms(seconds: float) -> int:
    return int(round(float(seconds) * 1000))


def media_problems(video: Optional[MediaFacts], audio: Optional[MediaFacts]) -> List[str]:
    """Why Kling would refuse these files, from the worker's measurements. Empty = send them. Pure."""
    out: List[str] = []
    if video is None:
        out.append("the video was not measured: a lip-sync is never sent on a file nobody checked")
    else:
        if video.format not in VIDEO_FORMATS:
            out.append(f"the video must be {' or '.join(VIDEO_FORMATS)}, not {video.format or '(unknown)'}")
        if not 0 < video.bytes <= VIDEO_MAX_BYTES:
            out.append("the video must be at most 100 MB")
        if not VIDEO_SECONDS[0] <= video.duration_s <= VIDEO_SECONDS[1]:
            out.append(f"the video must be {VIDEO_SECONDS[0]}-{VIDEO_SECONDS[1]} s long")
        if not video.width or not video.height:
            out.append("the video's size was not measured")
        elif (min(video.width, video.height) not in VIDEO_SHORT_SIDES_PX
              or not VIDEO_MIN_SIDE_PX <= min(video.width, video.height) <= max(video.width, video.height) <= VIDEO_MAX_SIDE_PX):
            out.append(f"the video must be 720p or 1080p with each side {VIDEO_MIN_SIDE_PX}-{VIDEO_MAX_SIDE_PX} px")
    if audio is None:
        out.append("the speech was not measured: a lip-sync is never sent on a file nobody checked")
    else:
        if audio.format not in AUDIO_FORMATS:
            out.append(f"the speech must be {', '.join(AUDIO_FORMATS)}, not {audio.format or '(unknown)'}")
        if not 0 < audio.bytes <= AUDIO_MAX_BYTES:
            out.append("the speech file must be at most 5 MB")
        if not AUDIO_SECONDS[0] <= audio.duration_s <= AUDIO_SECONDS[1]:
            out.append(f"the speech must be {AUDIO_SECONDS[0]}-{AUDIO_SECONDS[1]} s long")
    return out


def _window_shape_ok(w) -> bool:
    return isinstance(w, (tuple, list)) and len(w) == 3 and all(isinstance(x, int) and not isinstance(x, bool) for x in w)


def sound_window(request: CapabilityRequest) -> Optional[Tuple[int, int, int]]:
    """(start, end, insert) ms: the request's, else the whole speech file from the video's first frame. None = unmeasured or
    not three whole numbers of milliseconds (``window_problems`` says which)."""
    if request.sound_window_ms is not None:
        w = request.sound_window_ms
        return (w[0], w[1], w[2]) if _window_shape_ok(w) else None
    if request.input_audio_facts is None:
        return None
    return 0, _ms(request.input_audio_facts.duration_s), 0


def window_problems(request: CapabilityRequest) -> List[str]:
    if request.sound_window_ms is not None and not _window_shape_ok(request.sound_window_ms):
        return ["the sound window must be three whole numbers of milliseconds: start, end, insert"]
    w = sound_window(request)
    if w is None:
        return []                       # media_problems already says the speech was not measured
    start, end, insert = w
    out: List[str] = []
    if start < 0 or insert < 0 or end - start < MIN_OVERLAP_MS:
        out.append("the part of the speech used must be at least 2 s, with no negative time")
    if request.input_audio_facts is not None and end > _ms(request.input_audio_facts.duration_s):
        out.append("the sound window ends after the speech file does")
    if request.input_media_facts is not None and insert >= _ms(request.input_media_facts.duration_s):
        out.append("the speech is placed after the video ends")
    return out


def overlap_ms(face: Dict, window: Tuple[int, int, int]) -> Optional[int]:
    """How long the placed speech and the face's interval share, in ms; None when the face carries no interval."""
    fs, fe = face.get("start_time"), face.get("end_time")
    if not all(isinstance(v, int) and not isinstance(v, bool) for v in (fs, fe)):
        return None
    start, end, insert = window
    return min(fe, insert + (end - start)) - max(fs, insert)


class KlingLipsyncAdapter(KlingOmniEditAdapter):
    """Kling's advanced lip-sync. Auth, the key rule, Kling's business codes (1303 = rate_limited) and the result hosts are the
    Omni adapter's (``KlingOmniEditAdapter``): the same vendor, the same API key, the same CDN."""

    key = "video.kling_lipsync"
    capabilities = (LIPSYNC,)
    resolution_capabilities = ()
    #: Lip-sync has no model field; this is the registry's name for the endpoint.
    MODELS = ("advanced-lip-sync",)
    #: The output is the input video re-rendered (≤ 100 MB in, the same length out): far below the mixin's 512 MB default.
    max_result_bytes = 256 * 1024 * 1024

    def _spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        out = [] if vendor_model in self.MODELS else [f"{vendor_model!r} is not a Kling lip-sync endpoint this adapter knows"]
        if request.capability != LIPSYNC:
            return out + [f"adapter {self.key} cannot do {request.capability}"]
        if len(request.input_media) != 1:
            out.append("a lip-sync takes exactly one video")
        elif not is_url(str(request.input_media[0])):
            out.append("the video must be an https URL the vendor can fetch (a signed link)")
        if not request.input_audio or not is_url(str(request.input_audio)):
            out.append("the speech must be an https URL the vendor can fetch (a signed link)")
        if request.face_id is not None and not _FACE_ID.fullmatch(str(request.face_id)):
            out.append("the face id has an unexpected shape")
        if (request.prompt or "").strip():
            out.append("a lip-sync takes no words: the speech file is what the mouth follows")
        if request.input_images:
            out.append("a lip-sync takes no pictures")
        if request.resolution is not None or request.duration_s is not None or request.aspect_ratio is not None:
            out.append("the clip keeps its own size, length and shape: none of them applies")
        if request.audio is not None:
            out.append("an audio flag does not apply: the speech file is the sound")
        out += media_problems(request.input_media_facts, request.input_audio_facts)
        out += window_problems(request)
        return out

    # -- step 1: the billed face check -------------------------------------------------------------------------------
    def identify_face(self, video_url: str) -> Tuple[str, List[Dict]]:
        """``(session_id, face_data)``. Billed: an answer that never arrived is UNCONFIRMED SPEND."""
        data = self._check(self.submit_json(f"{self.base_url}/v1/videos/identify-face", {"video_url": video_url},
                                            what="identify-face"))
        sid = dig(data, "session_id") if isinstance(data, dict) else None
        faces = dig(data, "face_data") if isinstance(data, dict) else None
        if not isinstance(sid, str) or not _ID.fullmatch(sid) or not isinstance(faces, list):
            raise unconfirmed("the face check answered without a usable session id or face list")
        return sid, [f for f in faces if isinstance(f, dict)]

    @staticmethod
    def choose_face(faces: Sequence[Dict], wanted: Optional[str], session_id: str) -> Dict:
        """The one face to move, or a bad_request naming why none can be. Never the first of several."""
        billed = f"the face check (session {session_id}) was billed; no lip-sync was started"
        # Vendor values reach a stored message only in a shape we checked: an id of our pattern and whole milliseconds.
        def shown(f: Dict) -> str:
            fid = str(f.get("face_id"))
            times = [v if isinstance(v, int) and not isinstance(v, bool) else "?" for v in (f.get("start_time"), f.get("end_time"))]
            return f"{fid if _FACE_ID.fullmatch(fid) else '?'} ({times[0]}-{times[1]} ms)"

        listed = ", ".join(shown(f) for f in list(faces)[:8])
        if wanted is not None:
            match = [f for f in faces if str(f.get("face_id")) == str(wanted)]
            if len(match) == 1:
                return match[0]
            raise AdapterError(E_BAD_REQUEST, f"{FACE_NOT_FOUND}: the video has no face {wanted}; faces found: "
                                              f"{listed or 'none'}. Pick one of those, or use a clip of that person. {billed}")
        if not faces:
            raise AdapterError(E_BAD_REQUEST, f"{NO_FACE}: no face was found in the video. Use a clip where the speaker's face is "
                                              f"visible for at least 2 s. {billed}")
        if len(faces) > 1:
            raise AdapterError(E_BAD_REQUEST, f"{SEVERAL_FACES}: {len(faces)} faces were found ({listed}) and Kling moves only "
                                              f"one; name the face to move, or use a clip with one person. {billed}")
        return faces[0]

    # -- step 2: the lip-sync task -----------------------------------------------------------------------------------
    def build_body(self, request: CapabilityRequest, *, session_id: str, face_id, external_id: Optional[str] = None) -> Dict:
        start, end, insert = sound_window(request)  # type: ignore[misc]
        # No volume field: the assembly plays a lip-synced clip muted and takes the speech from the dialogue stem
        # (S6_GAPS §4), so the vendor's default mix is stored as it comes and nothing downstream depends on it.
        body: Dict = {"session_id": session_id,
                      "face_choose": [{"face_id": face_id, "sound_file": str(request.input_audio),
                                       "sound_start_time": start, "sound_end_time": end, "sound_insert_time": insert}]}
        if external_id and _ID.fullmatch(external_id):
            # Our job id: a task whose answer we lost can be found on Kling's side by it.
            body["external_task_id"] = external_id
        return body

    def submit(self, request: CapabilityRequest, vendor_model: str, *, external_id: Optional[str] = None) -> ProviderTask:
        self.require_key()
        bad = self._spec_problems(request, vendor_model)
        if bad:
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad), not_accepted=True)
        sid, faces = self.identify_face(str(request.input_media[0]))
        face = self.choose_face(faces, request.face_id, sid)
        window = sound_window(request)
        shared = overlap_ms(face, window)  # type: ignore[arg-type]
        if shared is None:
            raise AdapterError(E_BAD_RESPONSE, f"the face check (session {sid}) gave the face no interval; no lip-sync was started")
        if shared < MIN_OVERLAP_MS:
            # overlap_ms returned a number, so both times are whole milliseconds.
            raise AdapterError(E_BAD_REQUEST, f"{FACE_OVERLAP}: the speech overlaps the face's {face.get('start_time')}-"
                                              f"{face.get('end_time')} ms for {max(shared, 0)} ms; Kling needs 2000. Place the "
                                              f"speech where the face is on screen. The face check (session {sid}) was billed; "
                                              f"no lip-sync was started")
        fid = face.get("face_id")
        if not _FACE_ID.fullmatch(str(fid)):
            raise AdapterError(E_BAD_RESPONSE, f"the face check (session {sid}) named a face id of an unexpected shape; "
                                               f"no lip-sync was started")
        data = self._check(self.submit_json(f"{self.base_url}/v1/videos/advanced-lip-sync",
                                            self.build_body(request, session_id=sid, face_id=fid, external_id=external_id)))
        tid = dig(data, "task_id") if isinstance(data, dict) else None
        if not isinstance(tid, str) or not _ID.fullmatch(tid):
            raise unconfirmed(f"the lip-sync answer (session {sid}) carries no usable task id")
        return ProviderTask(self.key, vendor_model, f"{sid}/{fid}/{tid}")

    @staticmethod
    def parse_task_id(task_id) -> Tuple[str, str, str]:
        """``(session_id, face_id, task_id)`` from what a job row stored; a bad_request for anything else (it goes into a URL)."""
        parts = str(task_id or "").split("/")
        if len(parts) != 3 or not (_ID.fullmatch(parts[0]) and _FACE_ID.fullmatch(parts[1]) and _ID.fullmatch(parts[2])):
            raise AdapterError(E_BAD_REQUEST, "task id has an unexpected shape")
        return parts[0], parts[1], parts[2]

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        _, _, tid = self.parse_task_id(task.task_id)
        data = self._check(self.get(f"{self.base_url}/v1/videos/advanced-lip-sync/{tid}"))
        if not isinstance(data, dict):
            raise AdapterError(E_BAD_RESPONSE, "the task answer is not an object")
        if data.get("task_id") is not None and str(data.get("task_id")) != tid:
            raise AdapterError(E_BAD_RESPONSE, "the answer is about another task")
        status = str(data.get("task_status") or "").lower()
        if status in _RUNNING:
            return PollResult(PENDING)
        if status == "succeed":
            url = dig(data, "task_result", "videos", 0, "url")
            if not isinstance(url, str) or not url:
                raise after_completion(AdapterError(E_BAD_RESPONSE, "succeeded without a video URL"))
            return self.checked_outputs(PollResult(SUCCEEDED, [Output("video/mp4", url=url)]))
        if status == "failed":
            return _failed(self, data.get("task_status_msg") or "task failed")
        raise AdapterError(E_BAD_RESPONSE, f"unknown task status {self.message(status)[:40]!r}")


ADAPTERS: Sequence[type] = (KlingLipsyncAdapter,)

__all__ = ["ADAPTERS", "KlingLipsyncAdapter", "REASONS", "media_problems", "overlap_ms", "sound_window", "window_problems"]
