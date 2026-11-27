"""ElevenLabs Text to Dialogue with timestamps: one scene's lines, each in its character's voice, as one audio file.

Why this exists (docs/studio/S6_GAPS.md G5)
-------------------------------------------
A short film's lines had no voice except ``clip_audio``, which the video model makes and nobody has measured (S6_GAPS §1.4):
not the language, not the words, not a voice that stays the same across clips. Text to Dialogue hears the whole exchange at
once (turn-taking, interruptions) and says when each voice starts and ends, which is what the assembly needs to place a
scene's dialogue on the film's clock and what a lip-sync needs to know whose mouth moves when.

The call, as the API reference states it (read 2026-11-22,
https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert-with-timestamps):

* ``POST /v1/text-to-dialogue/with-timestamps``, body ``{inputs: [{text, voice_id}], model_id, language_code}``, query
  ``output_format``;
* "at most 10 unique voice IDs, and at most 2,000 total characters across all inputs[].text"; longer "can terminate early",
  so a longer scene is refused here, before any call, never sent and cut short;
* the answer is ``{audio_base64, voice_segments: [{voice_id, start_time_seconds, end_time_seconds, character_start_index,
  character_end_index, dialogue_input_index}], alignment, normalized_alignment}``.

The models page (https://elevenlabs.io/docs/overview/models, same day) ties the HTTP API to Eleven v4 and v3 only; v4 Turbo
and v3 Conversational are named for the websocket, which this adapter does not use.

What the result carries
-----------------------
One ``audio/mpeg`` Output whose ``provenance`` is S6_GAPS §4's dialogue record minus the two ids only the caller knows::

    {"kind": "dialogue", "lines": [{"character_id", "voice_id", "start_s", "end_s"}],
     "model": "<vendor model>", "language": "uz" | null, "loudness_lufs": null, "true_peak_db": null}

The caller (S2's film worker) adds ``film_take_id`` and ``scene_id`` and registers the file with it. Times are on the file's
own clock, straight from ``voice_segments``. Loudness is null because nothing here measured it (rule 5): the worker that
measures the file fills it in, or it stays null. No character alignment is kept: 0038 caps a provenance at 16 KB (Lens L4).

Every line maps to exactly one segment, in order and by voice. When the answer cannot be mapped that way the job fails
``bad_response``; a guess at who said what would put words in the wrong mouth (rules 4 and 5).

Registry-only for now (``REGISTRY_ONLY_CAPABILITIES``): no row in the database, no price, no job can start on it.
"""

from __future__ import annotations

import base64
import binascii
import math
import re
from typing import Any, Dict, List, Optional, Sequence

from modules import tts_languages
from modules.capabilities.audio import _EL_VOICE, VOICE_ID, _ElevenLabs
from modules.capabilities.base import (
    DIALOGUE,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    AdapterError,
    CapabilityRequest,
    Output,
    ProviderTask,
)

#: "at most 2,000 total characters across all inputs[].text values per request". Counted in UTF-16 code units, the way
#: model_registry.prompt_units counts a prompt: never fewer than the vendor's characters.
DIALOGUE_MAX_CHARS = 2000
#: "at most 10 unique voice IDs".
DIALOGUE_MAX_VOICES = 10
#: The models the HTTP endpoint is documented for. Anything else is refused, never sent and left to the vendor's default.
DIALOGUE_MODELS = frozenset({"eleven_v4", "eleven_v3"})
#: The film's own character id, echoed back in the provenance. Bounded so a provenance row stays small.
CHARACTER_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
OUTPUT_FORMAT = "mp3_44100_128"


def _units(text: str) -> int:
    return len((text or "").encode("utf-16-le")) // 2


def line_problems(request: CapabilityRequest, vendor_model: str) -> List[str]:
    """Why these lines cannot be sent to ``vendor_model``, before any call. Pure."""
    out: List[str] = []
    if vendor_model not in DIALOGUE_MODELS:
        out.append(f"Text to Dialogue takes {' or '.join(sorted(DIALOGUE_MODELS))} only, not {vendor_model}")
    if request.voice_id:
        # One voice for the whole request would be dropped on the floor: each line names its own.
        out.append("a single voice does not apply to dialogue: each line names its character's voice")
    lines = list(request.dialogue_lines or ())
    if not lines:
        out.append("dialogue needs its lines")
        return out
    voices, total = set(), 0
    for i, line in enumerate(lines, 1):
        if not (isinstance(line, (tuple, list)) and len(line) == 3 and all(isinstance(x, str) for x in line)):
            out.append(f"line {i} is not (character_id, voice_id, text)")
            continue
        character, voice, text = line
        if not CHARACTER_ID.fullmatch(character):
            out.append(f"line {i} has no usable character id")
        if not VOICE_ID.fullmatch(voice):
            out.append(f"line {i}: a voice_id from the account's voice list is required")
        # TODO(S6 G3): refuse a retired Default voice here once modules/voice_retirement.py lands (PR #924); it is not on main
        # yet, and importing it would break this module until then.
        if not text.strip():
            out.append(f"line {i} is empty")
        voices.add(voice)
        total += _units(text)
    if len(voices) > DIALOGUE_MAX_VOICES:
        out.append(f"a dialogue takes at most {DIALOGUE_MAX_VOICES} voices; this one has {len(voices)}: split the scene")
    if total > DIALOGUE_MAX_CHARS:
        # The vendor "can terminate early" above this: a scene cut short is worse than no scene.
        out.append(f"a dialogue takes at most {DIALOGUE_MAX_CHARS} characters; this one has {total}: "
                   "split the scene at a turn")
    reason = tts_languages.refusal(vendor_model, request.text_language)
    if reason:
        out.append(reason)
    return out


def decode_audio(value: Any) -> bytes:
    """The answer's ``audio_base64`` as bytes. Strict: a body that is not clean base64 fails closed rather than being decoded
    leniently into a file that plays as noise (base.b64_output is lenient for the image vendors; this is not)."""
    if not isinstance(value, str) or not value.strip():
        raise AdapterError(E_BAD_RESPONSE, "the dialogue answer has no audio")
    try:
        data = base64.b64decode(value.strip(), validate=True)
    except (binascii.Error, ValueError):
        raise AdapterError(E_BAD_RESPONSE, "the dialogue audio is not valid base64") from None
    if not data:
        raise AdapterError(E_BAD_RESPONSE, "the dialogue audio is empty")
    return data


def _seconds(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    return float(value)


def line_times(lines: Sequence[Sequence[str]], segments: Any) -> List[Dict[str, Any]]:
    """One ``{character_id, voice_id, start_s, end_s}`` per line, from ``voice_segments``. The n-th segment must be the n-th
    line: the same voice, the same ``dialogue_input_index`` when the vendor sends it, times that are real and in speaking
    order. Anything else raises ``bad_response``: the vendor produced audio (and billed it) that we cannot attribute."""
    if not isinstance(segments, list):
        raise AdapterError(E_BAD_RESPONSE, "the dialogue answer has no voice segments")
    if len(segments) != len(lines):
        raise AdapterError(E_BAD_RESPONSE, f"the dialogue answer has {len(segments)} voice segments for {len(lines)} lines: "
                                           "the lines cannot be told apart")
    out: List[Dict[str, Any]] = []
    previous_start = 0.0
    for i, (seg, (character, voice, _text)) in enumerate(zip(segments, lines)):
        if not isinstance(seg, dict):
            raise AdapterError(E_BAD_RESPONSE, f"voice segment {i + 1} is not an object")
        if seg.get("voice_id") != voice:
            raise AdapterError(E_BAD_RESPONSE, f"voice segment {i + 1} is not in line {i + 1}'s voice")
        index = seg.get("dialogue_input_index")
        if index is not None and (isinstance(index, bool) or index != i):
            raise AdapterError(E_BAD_RESPONSE, f"voice segment {i + 1} belongs to another line")
        start, end = _seconds(seg.get("start_time_seconds")), _seconds(seg.get("end_time_seconds"))
        if start is None or end is None or end < start:
            raise AdapterError(E_BAD_RESPONSE, f"voice segment {i + 1} has no usable times")
        if start < previous_start:
            # Out of speaking order: pairing by position would be a guess.
            raise AdapterError(E_BAD_RESPONSE, f"voice segment {i + 1} starts before the line before it")
        previous_start = start
        out.append({"character_id": character, "voice_id": voice, "start_s": round(start, 3), "end_s": round(end, 3)})
    return out


class ElevenLabsDialogueAdapter(_ElevenLabs):
    """``POST /v1/text-to-dialogue/with-timestamps``: synchronous, the answer is the audio and its per-voice times."""

    key = "audio.elevenlabs_dialogue"
    capabilities = (DIALOGUE,)
    #: The key rides in ``xi-api-key``, which requests would carry across a redirect; this endpoint answers JSON, never a 3xx.
    follow_redirects = False

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        out.extend(p for p in line_problems(request, entry.vendor_model_for(DIALOGUE)) if p not in out)
        return out

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        bad = line_problems(request, vendor_model)
        if bad:
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad))
        lines = [tuple(line) for line in request.dialogue_lines]
        body: Dict[str, Any] = {"inputs": [{"text": text, "voice_id": voice} for _c, voice, text in lines],
                                "model_id": vendor_model}
        language = tts_languages.vendor_language_code(vendor_model, request.text_language)
        if language:
            body["language_code"] = language
        try:
            answer = self._call("POST", f"{self.base_url}/v1/text-to-dialogue/with-timestamps", what="generate",
                                json_body=body, params={"output_format": OUTPUT_FORMAT})
        except AdapterError as e:
            raise self._dialogue_voice_refused(e) from None
        if not isinstance(answer, dict):
            raise AdapterError(E_BAD_RESPONSE, "the dialogue answer is not an object")
        audio = decode_audio(answer.get("audio_base64"))
        provenance = {"kind": "dialogue", "lines": line_times(lines, answer.get("voice_segments")),
                      "model": vendor_model, "language": tts_languages.language_code(request.text_language),
                      "loudness_lufs": None, "true_peak_db": None}
        return ProviderTask(self.key, vendor_model, None,
                            outputs=[Output("audio/mpeg", data=audio, provenance=provenance)])

    def _dialogue_voice_refused(self, err: AdapterError) -> AdapterError:
        """A dialogue names several voices and ElevenLabs does not say which one it refused: the remedy says so, and no other
        voice is tried in its place (rule 4). Only a 404 proves nothing was billed, as in ``_voice_refused``."""
        code = getattr(self, "last_vendor_code", "")
        if code not in _EL_VOICE and not (err.http_status == 404 and code == ""):
            return err
        return AdapterError(E_BAD_REQUEST,
                            f"a voice in this dialogue is not available on this ElevenLabs account ({code or 'HTTP 404'}): "
                            "check each character's voice against the account's voice list",
                            http_status=err.http_status, not_accepted=err.http_status == 404)


ADAPTERS = (ElevenLabsDialogueAdapter,)
