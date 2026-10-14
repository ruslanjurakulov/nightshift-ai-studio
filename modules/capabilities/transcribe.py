"""Speech-to-text through an ASYNCHRONOUS vendor (captions, migration 0072).

The synchronous speech-to-text adapter (audio.elevenlabs_scribe) holds one
HTTP request open for the whole recording. This one is the second shape the
captions job supports behind the same registry routing: upload the recording,
create a transcript, and let the worker poll it — so a long recording never
sits inside a single request, and a worker that restarts keeps the task id.

    POST {base}/v2/upload            raw bytes  -> {"upload_url"}
    POST {base}/v2/transcript        {"audio_url", "speech_models", "language_code" | "language_detection"}
                                     -> {"id", "status"}
    GET  {base}/v2/transcript/{id}   status queued | processing | completed | error;
                                     completed: {"language_code", "words": [{"text", "start", "end"}]}
                                     with start / end in MILLISECONDS.

The base URL and the key live in the worker's env only
(``ASSEMBLYAI_BASE_URL`` — https only — and ``ASSEMBLYAI_API_KEY``); the key is
sent in the ``authorization`` header and never appears in a message.

The answer is turned into exactly what the synchronous adapter hands back — one
``application/json`` output ``{"language", "words": [{"t", "s", "e"}]}`` in
SECONDS — and the worker cleans and stores it the same way, so everything after
this file (price, hold, refund, track, cues, export) is shared.

* the spoken language is sent only when the person named one (uz / ru / en);
  otherwise the vendor detects it and the detected language is stored;
* a recording with no speech is an EMPTY answer for the worker to turn into
  its own ``no_speech`` failure (the hold is released), never a vendor fault;
* speaker labels and the vendor's text rewriting are not asked for: only words
  and their times are kept.
"""

from __future__ import annotations

import json
import re
from typing import Dict, List

from modules import captions as caption_words
from modules.capabilities.audio import DUB_SUFFIXES, VENDOR_ID, _one_recording, _recording
from modules.capabilities.base import (
    CAPTIONS,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_POLICY,
    E_UNAVAILABLE,
    FAILED,
    PENDING,
    SUCCEEDED,
    AdapterError,
    CapabilityRequest,
    HttpAdapter,
    Output,
    PollResult,
    ProviderTask,
    dig,
    is_url,
)

#: Words in a failed transcript's reason that mean "there is nothing spoken in
#: this recording" (an empty track, not a fault).
_NO_SPEECH_WORDS = ("no spoken", "spoken audio", "no speech", "does not appear to contain", "silent", "silence")
#: Words that mean "this recording", not "the service".
_INPUT_WORDS = ("unsupported", "language", "duration", "too long", "too short", "file format", "decode", "corrupt")


class AsyncTranscriptionAdapter(HttpAdapter):
    """Upload -> create -> poll speech-to-text (module doc)."""

    key = "audio.async_transcribe"
    capabilities = (CAPTIONS,)
    key_env = ("ASSEMBLYAI_API_KEY",)
    base_url_env = "ASSEMBLYAI_BASE_URL"
    default_base_url = "https://api.assemblyai.com"
    #: One upload of a recording (up to the worker's 512 MB bound) is a long request.
    timeout = 600

    def auth_headers(self) -> Dict[str, str]:
        return {"authorization": self.api_key()}

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        out.extend(_one_recording(request, DUB_SUFFIXES))
        if request.voice_id:
            out.append("a voice does not apply to captions")
        return out

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        bad = _one_recording(request, DUB_SUFFIXES)
        lang = request.spoken_language
        if lang is not None and not re.fullmatch(r"[a-z]{2}", lang):
            bad.append("the spoken language must be a two-letter tag")
        if bad:
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad))
        _recording(request.input_media[0])  # type / size / readable, before any call
        with open(request.input_media[0], "rb") as fh:
            up = self._call("POST", f"{self.base_url}/v2/upload", what="upload", data=fh,
                            headers={"Content-Type": "application/octet-stream"})
        url = up.get("upload_url") if isinstance(up, dict) else None
        if not isinstance(url, str) or not is_url(url):
            raise AdapterError(E_BAD_RESPONSE, "the upload did not return a usable address")
        body: dict = {"audio_url": url, "speech_models": [vendor_model], "speaker_labels": False}
        if lang:
            body["language_code"] = lang
        else:
            body["language_detection"] = True
        made = self.post(f"{self.base_url}/v2/transcript", body, what="submit")
        task = made.get("id") if isinstance(made, dict) else None
        if not isinstance(task, str) or not VENDOR_ID.fullmatch(task):
            # The upload went out and the transcript may exist: fail now (the
            # hold is released) rather than guess an id.
            raise AdapterError(E_BAD_RESPONSE, "the transcript has no usable id")
        return ProviderTask(self.key, vendor_model, task)

    def poll(self, task: ProviderTask) -> PollResult:
        tid = str(task.task_id or "")
        if not VENDOR_ID.fullmatch(tid):
            raise AdapterError(E_BAD_REQUEST, "not a transcript task id")
        body = self.get(f"{self.base_url}/v2/transcript/{tid}")
        if not isinstance(body, dict):
            raise AdapterError(E_BAD_RESPONSE, "poll: not an object")
        status = body.get("status")
        if status in ("queued", "processing"):
            return PollResult(PENDING)
        if status == "completed":
            words = body.get("words")
            if words is None:
                words = []  # a recording with no speech: the worker refuses it as no_speech
            if not isinstance(words, list):
                return PollResult(FAILED, error=AdapterError(E_BAD_RESPONSE, "the transcript has no words"))
            kept = [{"t": w.get("text"), "s": _sec(w.get("start")), "e": _sec(w.get("end"))}
                    for w in words if isinstance(w, dict)]
            payload = json.dumps(caption_words.track_json(caption_words.base_language(body.get("language_code")), kept),
                                 ensure_ascii=False).encode("utf-8")
            return PollResult(SUCCEEDED, [Output("application/json", data=payload)])
        if status == "error":
            reason = self.message(body.get("error") or "the transcript failed without a reason")
            low = reason.lower()
            if any(w in low for w in _NO_SPEECH_WORDS):
                empty = json.dumps(caption_words.track_json(None, [])).encode("utf-8")
                return PollResult(SUCCEEDED, [Output("application/json", data=empty)])
            code = (E_POLICY if any(w in low for w in ("policy", "moderat", "safety")) else
                    E_BAD_REQUEST if any(w in low for w in _INPUT_WORDS) else E_UNAVAILABLE)
            return PollResult(FAILED, error=AdapterError(code, f"transcript failed: {reason}"))
        raise AdapterError(E_BAD_RESPONSE, f"poll: unknown transcript status {str(status)[:40]!r}")


def _sec(ms):
    """Milliseconds as the vendor counts them -> seconds; None stays None (the word is skipped, not guessed)."""
    if isinstance(ms, bool) or not isinstance(ms, (int, float)):
        return None
    return ms / 1000.0


ADAPTERS = (AsyncTranscriptionAdapter,)
