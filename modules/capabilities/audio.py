"""Audio adapters: ElevenLabs text-to-speech, sound effects, the voice
changer and dubbing.

TTS, sound effects and the voice changer are synchronous and answer with the
audio bytes, so ``submit`` finishes the job (paths and fields as in the
vendor's elevenlabs-python SDK and API reference). Dubbing is asynchronous:
``submit`` creates a dubbing project with its one language target and
``poll`` reads that target until it is ``completed`` (migration 0050).

The voice is never guessed: TTS and the voice changer need an explicit
``voice_id`` from the account's own list (CLAUDE.md ceiling — 20
alphanumerics), and a request without one is refused before any call. A dub
is made only in a language the registry entry lists (``languages``); there is
no "nearest language".
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, List, Optional, Sequence

from modules.capabilities.base import (
    DUB,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_POLICY,
    E_UNAVAILABLE,
    FAILED,
    PENDING,
    SFX,
    SUCCEEDED,
    TTS,
    VOICE_CHANGE,
    AdapterError,
    CapabilityRequest,
    HttpAdapter,
    Output,
    PollResult,
    ProviderTask,
    dig,
    is_url,
)

VOICE_ID = re.compile(r"^[A-Za-z0-9]{20}$")
#: Sound effects: the vendor accepts 0.5–30 s.
SFX_MAX_S = 30


class _ElevenLabs(HttpAdapter):
    key_env = ("ELEVENLABS_API_KEY",)
    base_url_env = "ELEVENLABS_BASE_URL"
    default_base_url = "https://api.elevenlabs.io"
    timeout = 180

    def auth_headers(self) -> Dict[str, str]:
        return {"xi-api-key": self.api_key()}

    def _audio(self, url: str, body: dict) -> Output:
        resp = self._call("POST", url, json_body=body, params={"output_format": "mp3_44100_128"},
                          headers={"Accept": "audio/mpeg"}, what="generate", raw=True)
        data = getattr(resp, "content", b"") or b""
        if not data:
            raise AdapterError(E_BAD_RESPONSE, "empty audio in the response")
        return Output("audio/mpeg", data=data)


class ElevenLabsTTSAdapter(_ElevenLabs):
    """``POST /v1/text-to-speech/{voice_id}`` with ``model_id``."""

    key = "audio.elevenlabs_tts"
    capabilities = (TTS,)

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        if not VOICE_ID.fullmatch(request.voice_id or ""):
            out.append("a voice_id from the account's voice list is required")
        return out

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        if not VOICE_ID.fullmatch(request.voice_id or ""):
            raise AdapterError(E_BAD_REQUEST, "a voice_id from the account's voice list is required")
        out = self._audio(f"{self.base_url}/v1/text-to-speech/{request.voice_id}",
                          {"text": request.prompt, "model_id": vendor_model})
        return ProviderTask(self.key, vendor_model, None, outputs=[out])


class ElevenLabsSFXAdapter(_ElevenLabs):
    """``POST /v1/sound-generation`` with ``model_id`` and ``duration_seconds``."""

    key = "audio.elevenlabs_sfx"
    capabilities = (SFX,)

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        body: dict = {"text": request.prompt.strip(), "model_id": vendor_model}
        if request.duration_s:
            if not 1 <= int(request.duration_s) <= SFX_MAX_S:
                raise AdapterError(E_BAD_REQUEST, f"duration must be 1–{SFX_MAX_S} s")
            body["duration_seconds"] = float(request.duration_s)
        out = self._audio(f"{self.base_url}/v1/sound-generation", body)
        return ProviderTask(self.key, vendor_model, None, outputs=[out])


# ── the voice tools (migration 0050) ────────────────────────────────────────

#: The recording types each tool is documented to take (the vendor's help
#: centre: "Which formats can be used as the input audio for Voice Changer?",
#: "Which file formats are supported by Dubbing?"), by the suffix the worker
#: gives its copy (modules/media_library.MEDIA_SOURCE_SUFFIX). 0050's source
#: check refuses the rest before anything is held; this is the second line.
MEDIA_MIME = {
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".flac": "audio/flac", ".aac": "audio/aac", ".weba": "audio/webm",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
}
VOICE_CHANGE_SUFFIXES = frozenset({".mp3", ".m4a", ".wav", ".ogg", ".flac", ".mp4", ".mov", ".webm", ".mkv"})
DUB_SUFFIXES = frozenset(MEDIA_MIME)
#: The largest recording sent (0050 refuses bigger sources at the price): the
#: multipart body is built in memory, so this bounds the worker's footprint.
MEDIA_MAX_BYTES = 512 * 1024 * 1024
#: Ids the vendor hands back and we put into URL paths.
VENDOR_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
#: Words in a failed dub's reason that mean "this recording", not "the service".
_INPUT_WORDS = ("transcri", "no speech", "speech", "silent", "unsupported", "language", "duration", "too long",
                "format", "decode")


def _one_recording(request: CapabilityRequest, suffixes: Sequence[str]) -> List[str]:
    out: List[str] = []
    if len(request.input_media) != 1:
        out.append("exactly one recording (audio or video) is required")
    elif Path(str(request.input_media[0])).suffix.lower() not in suffixes:
        out.append("this recording type is not accepted for this tool")
    if request.input_images:
        out.append("pictures do not apply to this tool")
    if (request.prompt or "").strip():
        out.append("a description does not apply to this tool")
    return out


def _recording(path: str):
    """(name, mime) of a recording for a multipart upload, or a typed refusal
    before any call. The name sent is the worker's copy name (``source.mp4``)
    — never the uploader's file name."""
    p = Path(str(path))
    mime = MEDIA_MIME.get(p.suffix.lower())
    if mime is None:
        raise AdapterError(E_BAD_REQUEST, "this recording type is not accepted")
    try:
        size = p.stat().st_size
    except OSError:
        raise AdapterError(E_BAD_REQUEST, "the recording could not be read") from None
    if size <= 0:
        raise AdapterError(E_BAD_REQUEST, "the recording is empty")
    if size > MEDIA_MAX_BYTES:
        raise AdapterError(E_BAD_REQUEST, "the recording is too large")
    return p.name, mime


class ElevenLabsVoiceChangerAdapter(_ElevenLabs):
    """``POST /v1/speech-to-speech/{voice_id}`` (multipart ``audio`` +
    ``model_id``; ``output_format`` in the query) — the "voice changer".
    Synchronous: the answer is the re-voiced audio."""

    key = "audio.elevenlabs_sts"
    capabilities = (VOICE_CHANGE,)

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        if not VOICE_ID.fullmatch(request.voice_id or ""):
            out.append("a voice_id from the account's voice list is required")
        out.extend(_one_recording(request, VOICE_CHANGE_SUFFIXES))
        return out

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        if not VOICE_ID.fullmatch(request.voice_id or ""):
            raise AdapterError(E_BAD_REQUEST, "a voice_id from the account's voice list is required")
        bad = _one_recording(request, VOICE_CHANGE_SUFFIXES)
        if bad:
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad))
        name, mime = _recording(request.input_media[0])
        with open(request.input_media[0], "rb") as fh:
            resp = self._call(
                "POST", f"{self.base_url}/v1/speech-to-speech/{request.voice_id}", what="generate",
                params={"output_format": "mp3_44100_128"}, headers={"Accept": "audio/mpeg"},
                files={"audio": (name, fh, mime)}, data={"model_id": vendor_model}, raw=True)
        data = getattr(resp, "content", b"") or b""
        if not data:
            raise AdapterError(E_BAD_RESPONSE, "empty audio in the response")
        return ProviderTask(self.key, vendor_model, None, outputs=[Output("audio/mpeg", data=data)])


class ElevenLabsDubbingAdapter(_ElevenLabs):
    """Dubbing projects (the current API, not the legacy ``/v1/dubbing``):

    * ``POST /v1/dubbing/project`` (multipart ``file``, ``model_id``,
      ``target_language``) — one project with its first language target. The
      vendor charges one language's dub here, which the first target consumes;
    * ``GET /v1/dubbing/project/{project_id}/language/{language_id}`` until
      ``completed``, when ``outputs.lossless_audio`` is a signed FLAC URL
      (valid one hour; it is fetched straight away and re-read on each poll).

    The task id is ``<project_id>/<language_id>``. The source language is
    left to the vendor's detection; the dub is the audio track only.
    """

    key = "audio.elevenlabs_dub"
    capabilities = (DUB,)

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        out.extend(_one_recording(request, DUB_SUFFIXES))
        langs = tuple(entry.raw.get("languages") or ())
        if request.target_language not in langs:
            out.append(f"{entry.id} does not dub into {request.target_language or '(no language)'}")
        if request.voice_id:
            out.append("a voice does not apply to a dub: the speakers keep their own")
        return out

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        bad = _one_recording(request, DUB_SUFFIXES)
        lang = request.target_language or ""
        if not re.fullmatch(r"[a-z]{2,3}", lang):
            bad.append("a target language is required")
        if bad:
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad))
        name, mime = _recording(request.input_media[0])
        with open(request.input_media[0], "rb") as fh:
            body = self._call(
                "POST", f"{self.base_url}/v1/dubbing/project", what="submit",
                files={"file": (name, fh, mime)},
                data={"model_id": vendor_model, "target_language": lang})
        project = body.get("project_id") if isinstance(body, dict) else None
        if not isinstance(project, str) or not VENDOR_ID.fullmatch(project):
            raise AdapterError(E_BAD_RESPONSE, "the dubbing project has no usable id")
        ids = body.get("language_ids") if isinstance(body.get("language_ids"), list) else []
        language = ids[0] if len(ids) == 1 else None
        if not isinstance(language, str) or not VENDOR_ID.fullmatch(language):
            # The project exists (and is charged); without the target's id the
            # result could never be read back. Fail now — the hold is released.
            raise AdapterError(E_BAD_RESPONSE, "the dubbing project did not name its language target")
        return ProviderTask(self.key, vendor_model, f"{project}/{language}")

    @staticmethod
    def _ids(task_id: Optional[str]):
        project, sep, language = str(task_id or "").partition("/")
        if not sep or not VENDOR_ID.fullmatch(project) or not VENDOR_ID.fullmatch(language):
            raise AdapterError(E_BAD_REQUEST, "not a dubbing task id")
        return project, language

    def poll(self, task: ProviderTask) -> PollResult:
        project, language = self._ids(task.task_id)
        body = self.get(f"{self.base_url}/v1/dubbing/project/{project}/language/{language}")
        if not isinstance(body, dict):
            raise AdapterError(E_BAD_RESPONSE, "poll: not an object")
        status = body.get("status")
        if status in ("queued", "processing"):
            return PollResult(PENDING)
        if status == "completed":
            url = dig(body, "outputs", "lossless_audio")
            if not isinstance(url, str) or not is_url(url):
                return PollResult(FAILED, error=AdapterError(E_BAD_RESPONSE, "the dub finished without its audio"))
            # The signed URL is fetched as is: no key goes with it.
            return PollResult(SUCCEEDED, [Output("audio/flac", url=url)])
        if status == "failed":
            reason = self.message(dig(body, "error", "error") or "the dub failed without a reason")
            low = reason.lower()
            code = (E_POLICY if any(w in low for w in ("policy", "moderat", "safety")) else
                    E_BAD_REQUEST if any(w in low for w in _INPUT_WORDS) else E_UNAVAILABLE)
            return PollResult(FAILED, error=AdapterError(code, f"dub failed: {reason}"))
        if status == "stale":
            # Only an edit makes a target stale, and nothing here edits one:
            # an output that may not match the source is not handed out.
            return PollResult(FAILED, error=AdapterError(E_BAD_RESPONSE, "the dub changed after it was made"))
        raise AdapterError(E_BAD_RESPONSE, f"poll: unknown dub status {str(status)[:40]!r}")


ADAPTERS = (ElevenLabsTTSAdapter, ElevenLabsSFXAdapter, ElevenLabsVoiceChangerAdapter, ElevenLabsDubbingAdapter)
