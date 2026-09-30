"""Audio adapters: ElevenLabs text-to-speech and sound effects.

Both endpoints are synchronous and answer with the audio bytes, so ``submit``
finishes the job (paths and fields as in the vendor's elevenlabs-python SDK).
The voice is never guessed: TTS needs an explicit ``voice_id`` from the
account's own list (CLAUDE.md ceiling — 20 alphanumerics), and a request
without one is refused before any call.
"""

from __future__ import annotations

import re
from typing import Dict, List

from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    SFX,
    TTS,
    AdapterError,
    CapabilityRequest,
    HttpAdapter,
    Output,
    ProviderTask,
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


ADAPTERS = (ElevenLabsTTSAdapter, ElevenLabsSFXAdapter)
