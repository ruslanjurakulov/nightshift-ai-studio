"""Gemini API text-to-speech: ``gemini-3.8-flash-tts`` and ``gemini-3.8-flash-lite-tts`` (narration and 2-voice dialogue).

Built 2026-11-21 for the post-event release, DARK: both registry entries carry a terms_gate and requires_adult, and no
real call has been made through this adapter yet (no key was available to the builder). tools/probe_gemini_tts.py is
the one-off owner listening probe.

What this rests on, and how sure it is
--------------------------------------
From the vendor's page (https://aistudio.google.com/docs/speech-generation, read 2026-11-21 for the research in
D:/vera/reports/uz-voice-options.md; the page could NOT be re-read while this file was written):

* the two model ids; "Northern Uzbek", Russian and English ticked for both (no language codes: the model detects the
  language from the text, so no language field is sent; the gate below is ours);
* multi-speaker "supports up to 2 speakers using prebuilt voices";
* output is WAV / L16, 24 kHz, mono; no timestamps.

UNVERIFIED for the 3.8 models (taken from the Gemini API's generateContent TTS shape as published for the earlier TTS
models, and kept in ONE function, :func:`build_body`, so a correction is one edit):

* ``POST {base}/models/{model}:generateContent`` with ``generationConfig.responseModalities = ["AUDIO"]`` and
  ``generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`` (one voice) or
  ``...speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs[] = {speaker, voiceConfig}`` (two);
* the answer ``candidates[0].content.parts[].inlineData = {mimeType, data (base64)}``;
* the style direction sent as a leading "<direction>: " before the words, the way that shape's examples steer
  delivery ("Say cheerfully: ..."). The repo's research (docs/research/AZURE_GEMINI_SPEECH_STUDIO.md §2.2, read
  2026-11-14) quotes a newer shape for the 3.8 models (``speech_config.speakers`` and a per-turn
  ``speech_metadata.style``); which one the generateContent endpoint takes for 3.8 must be confirmed before launch;
* the prebuilt voice list (:data:`PREBUILT_VOICES`, the 30 names of the earlier TTS docs; the research counts "30
  prebuilt voices" for 3.8 too, the names were not re-read);
* raw L16 being little-endian 16-bit samples (the vendor's own sample code writes the bytes straight into a WAV).

Rules this adapter keeps
------------------------
* The content language is the CALLER's (project, channel or explicit choice, never the UI locale) and is required:
  only a verified "yes" in modules/tts_languages.py passes (uz, ru, en). Anything else, unknown included, is refused
  with its reason; no other voice or model is ever tried (CLAUDE.md rule 4).
* A voice is a documented prebuilt name, never a guess and never a default.
* Errors carry the remedy (rule 6): a rejected key (401 / 403 / Google's 400 "API key not valid") is ``auth``; an
  account out of billing / paid quota is ``quota``; a 429 rate limit is ``rate_limited`` (the one transient answer
  besides 5xx / network, which are ``unavailable``); a blocked prompt is ``policy``. Nothing here retries.
* The key rides only in the ``x-goog-api-key`` header, redirects are refused, and every message is scrubbed (base).
"""

from __future__ import annotations

import base64
import re
import struct
from typing import Dict, List, Optional, Sequence, Tuple

from modules import tts_languages
from modules.capabilities.base import (
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_POLICY,
    E_QUOTA,
    E_RATE_LIMITED,
    TTS,
    AdapterError,
    CapabilityRequest,
    HttpAdapter,
    Output,
    ProviderTask,
    dig,
    json_body,
)
from modules.capabilities.google_interactions import BILLING_UNKNOWN, google_error_code

MODELS = ("gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts")
#: "supports up to 2 speakers using prebuilt voices" (speech-generation page). A third character is a separate request.
MAX_SPEAKERS = 2
#: The longest text sent, prompt + style together, in UTF-16 units (what ``model_registry.prompt_units`` counts).
#: CONSERVATIVE, not a vendor number: the speech page states no input limit; the research cites 8,192 input tokens
#: (repo doc [G8], not re-read) and 16,384 output tokens = about 655 s of audio at 25 tokens/s. 4,000 characters is
#: under the input bound even at one token per character (Uzbek tokenisation is not measured) and about 4-5 minutes
#: of speech, well under the output bound, so a text is never cut off mid-sentence by the output cap.
MAX_TEXT_CHARS = 4000
MAX_STYLE_CHARS = 300
#: The prebuilt voice names (UNVERIFIED for 3.8, see the module docstring). Matched exactly: "kore" is not a voice.
PREBUILT_VOICES = frozenset({
    "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
    "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia",
    "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix",
    "Sadachbia", "Sadaltager", "Sulafat",
})
#: A speaker label is the name a dialogue line starts with ("Dilnoza: ..."): letters (any script), digits, space,
#: apostrophe, hyphen. No colon or newline, or the label could forge another speaker's line.
_LABEL = re.compile(r"^[^\W_](?:[\w '\u02bb\u02bc\u2019-]{0,38}[^\W_])?$")
#: Why the model stopped when it says it stopped for the content (Gemini finishReason / blockReason values).
#: Not "OTHER": it says nothing about the content, and reading it as "change the words" would be a guessed remedy.
_BLOCK_REASONS = frozenset({"SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"})
#: Account-level words in a 429: an exhausted paid / free allowance or billing is the operator's to fix (quota), not
#: a slow-down. The bare word "quota" is NOT here: Google's per-minute rate limit says "quota" too, and a rate limit
#: read as "top up" would send the operator to the wrong fix.
_ACCOUNT_WORDS = ("billing", "free tier", "paid tier", "credit", "payment", "spending", "prepay")
_PCM_RATE = re.compile(r"(?:^|;)\s*rate\s*=\s*(\d{4,6})\s*(?:;|$)")


def _refused_content(message: str, *, http_status=None) -> AdapterError:
    return AdapterError(E_POLICY, f"{BILLING_UNKNOWN}. {message}", http_status=http_status)


def pcm_to_wav(pcm: bytes, rate: int, *, channels: int = 1, bits: int = 16) -> bytes:
    """A canonical 44-byte-header PCM WAV around raw little-endian samples. The pipeline and the media library take
    ``audio/wav`` (media_library.sniff reads RIFF/WAVE); no transcoding, so nothing is lost or re-encoded."""
    block = channels * bits // 8
    header = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + len(pcm), b"WAVE", b"fmt ", 16, 1, channels, rate,
                         rate * block, block, bits, b"data", len(pcm))
    return header + pcm


def _labels_in(text: str) -> List[str]:
    return [m.group(1).strip() for m in re.finditer(r"^\s*([^:\n]{1,40}):", text, re.M)]


def build_body(request: CapabilityRequest) -> dict:
    """The generateContent body for one checked request (the UNVERIFIED shape lives here and only here)."""
    text = request.prompt.strip()
    if request.style:
        text = f"{request.style.strip()}: {text}" if not request.speakers else f"{request.style.strip()}:\n{text}"
    if request.speakers:
        speech = {"multiSpeakerVoiceConfig": {"speakerVoiceConfigs": [
            {"speaker": label, "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}}
            for label, voice in request.speakers]}}
    else:
        speech = {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": request.voice_id}}}
    return {"contents": [{"parts": [{"text": text}]}],
            "generationConfig": {"responseModalities": ["AUDIO"], "speechConfig": speech}}


class GeminiTTSAdapter(HttpAdapter):
    """``POST {base}/models/{model}:generateContent`` answering audio, synchronously."""

    key = "audio.gemini_tts"
    capabilities = (TTS,)
    dialogue_capabilities = (TTS,)
    style_capabilities = (TTS,)
    key_env = ("GEMINI_API_KEY",)
    base_url_env = "GEMINI_BASE_URL"
    default_base_url = "https://generativelanguage.googleapis.com/v1beta"
    #: The key rides in a header that requests does not strip on a cross-host redirect: a 3xx is an error.
    follow_redirects = False
    timeout = 180
    #: The audio comes back inline as base64; 4,000 characters of speech is a few MB of 24 kHz PCM. A cap stops a
    #: runaway answer from being decoded into memory.
    max_inline_bytes = 64 * 1024 * 1024

    def auth_headers(self) -> Dict[str, str]:
        # Google takes the key in its own header; never in the query string, where it would reach access logs.
        return {"x-goog-api-key": self.api_key()}

    def vendor_error_code(self, status: int, text: str) -> Optional[str]:
        code = google_error_code(text)
        if code is not None:
            return code
        if status == 429:
            # classify_http calls any 429 mentioning "quota" an empty balance, and Google's per-minute limit says
            # "quota": a slow-down would read as "top up the vendor" and never be retried. Only account words decide.
            err = json_body(text).get("error")
            low = str((err or {}).get("message") if isinstance(err, dict) else text or "").lower()
            return E_QUOTA if any(w in low for w in _ACCOUNT_WORDS) else E_RATE_LIMITED
        return None

    # -- checks, all before any call -------------------------------------------------
    def spec_problems(self, request: CapabilityRequest, vendor_model: str) -> List[str]:
        out: List[str] = []
        if vendor_model not in MODELS:
            out.append(f"{vendor_model!r} is not a Gemini TTS model this adapter knows")
        out.extend(self._language_problems(request, vendor_model))
        speakers: Sequence[Tuple[str, str]] = tuple(request.speakers or ())
        if speakers:
            if request.voice_id:
                out.append("a dialogue names a voice per speaker: leave the single voice empty")
            if len(speakers) > MAX_SPEAKERS:
                out.append(f"Gemini TTS reads at most {MAX_SPEAKERS} speakers in one request; split the scene so each "
                           f"request has two speakers, or give a third character a separate request")
            elif len(speakers) < 2:
                out.append("a dialogue needs exactly two speakers; one speaker is narration (a single voice)")
            labels = []
            for pair in speakers:
                if not (isinstance(pair, (tuple, list)) and len(pair) == 2):
                    out.append("each speaker is a (name, voice) pair")
                    continue
                label, voice = (str(pair[0] or "").strip(), str(pair[1] or ""))
                labels.append(label)
                if not _LABEL.fullmatch(label):
                    out.append(f"speaker name {label[:40]!r} must be 1-40 letters, digits, spaces, apostrophes or hyphens")
                if voice not in PREBUILT_VOICES:
                    out.append(f"{voice[:40]!r} is not one of Gemini's prebuilt voices: pick one from the list")
            if len(set(labels)) != len(labels):
                out.append("the two speakers need different names")
            used = set(_labels_in(request.prompt or ""))
            missing = [lab for lab in labels if lab and lab not in used]
            if missing:
                out.append("the dialogue has no line for " + ", ".join(repr(m) for m in missing)
                           + ": write each line as 'Name: words'")
            stray = sorted(lab for lab in used - set(labels))
            if stray and not missing:
                out.append("these line names are not speakers of this dialogue: " + ", ".join(repr(s) for s in stray[:4]))
        elif (request.voice_id or "") not in PREBUILT_VOICES:
            out.append("a voice from Gemini's prebuilt list is required (none is ever picked for you)")
        if request.style is not None:
            style = request.style.strip()
            if not style:
                out.append("the delivery style is empty: leave it out instead")
            elif len(style) > MAX_STYLE_CHARS or "\n" in style:
                out.append(f"the delivery style is one line of at most {MAX_STYLE_CHARS} characters")
        total = len(((request.style or "") + (request.prompt or "")).encode("utf-16-le")) // 2
        if total > MAX_TEXT_CHARS:
            out.append(f"the text and style are {total} characters together; Gemini TTS takes at most "
                       f"{MAX_TEXT_CHARS} here: split it into shorter parts")
        return out

    @staticmethod
    def _language_problems(request: CapabilityRequest, vendor_model: str) -> List[str]:
        lang = request.text_language
        if not (isinstance(lang, str) and lang.strip()):
            # Not judged elsewhere when absent (tts_languages), but here an unknown language would be a guess about
            # what the voice can read: the caller passes the content language (project / channel / explicit choice).
            return ["the content language is required (the project's, the channel's or the one chosen explicitly; "
                    "never the interface language)"]
        code = tts_languages.language_code(lang)
        if tts_languages.speaks(vendor_model, code) is True:
            return []
        url, read_on = tts_languages.MODEL_SOURCES.get(vendor_model, (tts_languages.GEMINI_SOURCE_URL, "?"))
        named = code or lang.strip()[:40]
        return [f"{vendor_model} is not verified for language {named!r}: only Northern Uzbek (uz), Russian (ru) and "
                f"English (en) were checked on {url} (read {read_on}). No other voice or model is substituted"]

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        out.extend(self.spec_problems(request, entry.vendor_model_for(TTS)))
        return out

    # -- the call ------------------------------------------------------------------
    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        bad = ([] if request.capability == TTS else [f"adapter {self.key} cannot do {request.capability}"])
        if not (request.prompt or "").strip():
            bad.append("the text is empty")
        bad += self.spec_problems(request, vendor_model)
        if bad:
            # Nothing was sent: a refusal, not a lost answer.
            raise AdapterError(E_BAD_REQUEST, "; ".join(bad), not_accepted=True)
        body = self._call("POST", f"{self.base_url}/models/{vendor_model}:generateContent",
                          json_body=build_body(request), what="generate")
        return ProviderTask(self.key, vendor_model, None, outputs=[self._audio(body)])

    def _audio(self, body) -> Output:
        if not isinstance(body, dict):
            raise AdapterError(E_BAD_RESPONSE, "the answer is not a JSON object")
        block = dig(body, "promptFeedback", "blockReason")
        if block:
            raise _refused_content(f"Google blocked the text ({self.message(block)}): change the words")
        cand = dig(body, "candidates", 0)
        if not isinstance(cand, dict):
            raise AdapterError(E_BAD_RESPONSE, "the answer carries no candidate")
        parts = dig(cand, "content", "parts")
        inline = None
        for part in parts if isinstance(parts, list) else []:
            d = part.get("inlineData") or part.get("inline_data") if isinstance(part, dict) else None
            if isinstance(d, dict) and d.get("data"):
                inline = d
                break
        finish = str(cand.get("finishReason") or "").upper()
        if inline is None:
            if finish in _BLOCK_REASONS:
                raise _refused_content(f"Google stopped the speech ({self.message(finish)}): change the words")
            raise AdapterError(E_BAD_RESPONSE, f"the answer carries no audio (finish {self.message(finish) or 'missing'})")
        if finish == "MAX_TOKENS":
            # The audio was cut off at the output cap: a narration missing its end is not delivered (rule 4).
            raise AdapterError(E_BAD_REQUEST, "the speech was cut off at Google's output limit: split the text")
        data = inline["data"]
        if not isinstance(data, str) or len(data) * 3 // 4 > self.max_inline_bytes:
            raise AdapterError(E_BAD_RESPONSE, "the inline audio is missing or over the size limit; not decoded")
        try:
            raw = base64.b64decode(data, validate=True)
        except (ValueError, TypeError):
            raw = b""
        if not raw:
            raise AdapterError(E_BAD_RESPONSE, "the inline audio is not valid base64")
        mime = str(inline.get("mimeType") or inline.get("mime_type") or "").strip().lower()
        return Output("audio/wav", data=self._as_wav(raw, mime))

    def _as_wav(self, raw: bytes, mime: str) -> bytes:
        base = mime.split(";", 1)[0].strip()
        if base in ("audio/wav", "audio/x-wav", "audio/wave"):
            if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
                raise AdapterError(E_BAD_RESPONSE, "the answer says WAV but the bytes are not a WAV file")
            return raw
        if base in ("audio/l16", "audio/pcm"):
            m = _PCM_RATE.search(mime.split(";", 1)[1] if ";" in mime else "")
            if not m:
                # The sample rate decides the pitch and speed. A guessed one would deliver a voice that sounds wrong
                # with nothing failing (rules 4 and 5), so an answer that does not state it is not delivered.
                raise AdapterError(E_BAD_RESPONSE, f"the raw audio does not state its sample rate ({self.message(mime)!r})")
            rate = int(m.group(1))
            if not 8000 <= rate <= 48000 or len(raw) % 2:
                raise AdapterError(E_BAD_RESPONSE, "the raw audio has an impossible sample rate or a half sample")
            return pcm_to_wav(raw, rate)
        raise AdapterError(E_BAD_RESPONSE, f"the audio is {self.message(mime) or 'of no stated type'!r}, "
                                           f"not WAV or 16-bit PCM")


ADAPTERS = (GeminiTTSAdapter,)
