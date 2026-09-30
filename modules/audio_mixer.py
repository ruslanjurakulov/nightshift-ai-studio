"""Stage 3: TTS & Audio Mixer — Multi-voice narration + SFX + Dynamic music."""

import asyncio
import hashlib
import logging
import re
import shutil
from pathlib import Path

import edge_tts
import requests
from pydub import AudioSegment
from pydub.effects import normalize

from config import (
    EDGE_TTS_VOICE,
    ELEVENLABS_API_KEY,
    ELEVENLABS_MODEL_ID,
    ELEVENLABS_RUN_VOICE_ID,
    ELEVENLABS_SECONDARY_VOICE_ID,
    ELEVENLABS_VOICE_ID,
    MUSIC_DIR,
    NARRATOR_VOLUME,
    OUTPUT_DIR,
    SFX_DIR,
    SFX_VOLUME,
    TTS_PROVIDER,
)
from modules.script_engine import Script

logger = logging.getLogger(__name__)

# Secondary (mysterious/deep) voice for quotes
EDGE_TTS_SECONDARY_VOICE = "en-US-GuyNeural"

# Music cue → volume dB mapping (applied as volume reduction from 0 dB base)
MUSIC_VOLUME_MAP = {
    "intro_high": -8,   # loud, energetic
    "story_low": -22,   # quiet background
    "climax_high": -6,  # loudest
    "outro": -14,
}

# Pattern-interrupt interval: add a subtle audio trigger every N seconds
PATTERN_INTERRUPT_INTERVAL = 35  # seconds

ELEVENLABS_API = "https://api.elevenlabs.io/v1"


class VoiceUnavailable(RuntimeError):
    """This channel's narrator cannot speak, and no substitute will be used."""


#: The explicit "read the [VOICE:secondary] lines in the narrator's voice"
#: choice — distinct from "not chosen", which stops the run.
NARRATOR = "narrator"
_VOICE_ID = re.compile(r"[A-Za-z0-9]{20}")


def verify_voice(channel=None) -> None:
    """Check the narrator before the run spends anything. Raise if it cannot speak.

    Why this refuses to fall back
    -----------------------------
    The obvious repair for a dead ElevenLabs key is to narrate with edge
    instead: it is free, needs no credentials, and the run would finish. That
    repair is wrong here. A channel is set to ElevenLabs *for the voice*, and
    with auto publish on nobody hears the result before the audience does. A
    video that goes out in the wrong voice is worse than one that never goes
    out — it is the moment a viewer notices the channel is a machine. No video
    is the better failure.

    Why it runs this early
    ----------------------
    By the time the audio stage is reached, the run has already paid for topic
    selection, research, a script and a fact-check pass — four Gemini calls and
    several minutes of runner time. Run #20 died exactly there, on a key that
    was never going to work. Checking costs one request that synthesizes no
    characters.

    A network failure is deliberately NOT fatal: the same call will be made for
    real a few stages later, and a transient blip must not be the thing that
    stops a run.
    """
    agent = channel.agent if channel is not None else None
    provider = agent.tts_provider if agent else TTS_PROVIDER
    if provider != "elevenlabs":
        return

    voice_id = narrator_voice(agent)
    if not ELEVENLABS_API_KEY:
        raise VoiceUnavailable(
            "This channel narrates with ElevenLabs, but ELEVENLABS_API_KEY is empty. "
            "Add it to the repository secrets, or set the channel's tts_provider to "
            "'edge'. Refusing to narrate in a different voice than the channel's."
        )
    if not voice_id:
        raise VoiceUnavailable(
            "This channel narrates with ElevenLabs, but no voice id is set. "
            "Set elevenlabs_voice_id for the channel, or switch it to 'edge'."
        )
    # The script format puts quotes and character speech in [VOICE:secondary]
    # lines, so an ElevenLabs run needs a second voice too. It used to be a
    # voice id typed into this file — a library voice that a free-plan account
    # may not use through the API; runs #147 and #159 died on it (HTTP 402,
    # paid_plan_required) after paying for topic, research and script.
    secondary = secondary_voice(agent)
    if not secondary:
        raise VoiceUnavailable(
            "This channel narrates with ElevenLabs, but no second voice is chosen for the "
            "script's quoted lines ([VOICE:secondary]). Pick one from the account's voices in "
            "the Command Center (Agents → Voice → Quote voice), or choose 'quotes in the "
            "narrator's voice' there; for the default channel the ELEVENLABS_SECONDARY_VOICE_ID "
            "variable does the same. No voice is picked for you."
        )

    if secondary != NARRATOR and not _VOICE_ID.fullmatch(secondary):
        # It goes into a request path; and a voice id is 20 letters and digits
        # (CLAUDE.md known ceilings), so anything else was typed, not picked.
        raise VoiceUnavailable(
            f"The quote voice {secondary!r} is not an ElevenLabs voice id (20 letters and "
            "digits). Pick it from the account's voice list in the Command Center."
        )

    _verify_voice_exists(voice_id)
    if secondary != NARRATOR and secondary != voice_id:
        _verify_voice_exists(secondary)


def secondary_voice(agent) -> str:
    """The voice this run reads [VOICE:secondary] lines in: the channel's
    choice, else the deployment default, else "" (not chosen). ``NARRATOR`` is
    returned as is — the caller decides what the narrator's voice is."""
    chosen = getattr(agent, "elevenlabs_secondary_voice_id", "") if agent is not None else ""
    if not isinstance(chosen, str):
        chosen = ""
    return chosen.strip() or ELEVENLABS_SECONDARY_VOICE_ID


def _verify_voice_exists(voice_id: str) -> None:
    """One request that synthesizes nothing: does this account have the voice?"""
    try:
        resp = requests.get(
            f"{ELEVENLABS_API}/voices/{voice_id}",
            headers={"xi-api-key": ELEVENLABS_API_KEY},
            timeout=15,
        )
    except Exception as e:
        logger.warning(
            "Could not reach ElevenLabs to verify the voice (%s: %s) — continuing; "
            "the narration stage will surface it if it is real",
            type(e).__name__, e,
        )
        return

    if resp.status_code == 200:
        return

    # Quote ElevenLabs' own reason rather than guessing at it: "invalid_api_key"
    # and "quota_exceeded" are the same HTTP status and need opposite fixes.
    detail = ""
    try:
        body = resp.json().get("detail") or {}
        detail = body.get("status") or body.get("message") or ""
    except Exception:
        pass

    if resp.status_code == 404:
        raise VoiceUnavailable(
            f"ElevenLabs has no voice with id {voice_id!r} for this account. "
            "Copy the id from the Voices page — they look like "
            "'pNInz6obpgDQGcFmaJgB', not a plain number."
        )
    raise VoiceUnavailable(
        f"ElevenLabs refused the credentials (HTTP {resp.status_code}"
        + (f", {detail}" if detail else "")
        + "). 'invalid_api_key' means the key is wrong or missing; "
        "'quota_exceeded' means the account is out of characters."
    )


def _tts_refusal(voice_id: str, status, body) -> str:
    """ElevenLabs' own reason for refusing a synthesis, and what to do about it.
    Only the voice id, the status and ElevenLabs' code/message are quoted —
    never the key or the request."""
    detail = body.get("detail") if isinstance(body, dict) else None
    detail = detail if isinstance(detail, dict) else {}
    code = str(detail.get("code") or detail.get("status") or "")
    message = " ".join(str(detail.get("message") or "").split())[:200]
    head = f"ElevenLabs refused to read with voice {voice_id!r} (HTTP {status}"
    head += f", {code})" if code else ")"
    if message:
        head += f": {message}"
    if code == "paid_plan_required" or status == 402:
        fix = ("Pick a voice this plan can use from the account's own voice list in the Command "
               "Center (Agents → Voice), or upgrade the ElevenLabs plan.")
    elif status == 404:
        fix = "The account has no such voice; pick one from its voice list in the Command Center."
    elif status == 401:
        fix = "'invalid_api_key' means the key is wrong; 'quota_exceeded' means the account is out of characters."
    else:
        fix = "No other voice is substituted; fix the cause and re-run."
    return f"{head}. {fix}"


def narrator_voice(agent) -> str:
    """The ElevenLabs voice this run narrates with: the run's own choice
    (ELEVENLABS_RUN_VOICE_ID, set from the Create page) when there is one, else
    the channel's voice, else the repo default. verify_voice checks this same
    id, so the voice that is verified is the voice that speaks."""
    if ELEVENLABS_RUN_VOICE_ID:
        return ELEVENLABS_RUN_VOICE_ID
    return (agent.elevenlabs_voice_id if agent else ELEVENLABS_VOICE_ID) or ""


class AudioMixer:
    """Builds one video's audio.

    An optional ``channel`` supplies that channel's TTS provider and narrator
    voice, so Extinct World and Nightshift Finance can sound different without two
    mixers existing. Without one, the values come from ``config.py`` exactly as
    before. The secondary voice is a fixed contrast voice in both cases — it is
    a dramatic device inside the script format, not a channel identity.
    """

    def __init__(self, topic_slug: str, channel=None):
        self.slug = topic_slug
        self.channel = channel
        agent = channel.agent if channel is not None else None
        self.tts_provider = agent.tts_provider if agent else TTS_PROVIDER
        self.main_elevenlabs_voice = narrator_voice(agent)
        self.secondary_elevenlabs_voice = secondary_voice(agent)
        self.main_edge_voice = agent.edge_tts_voice if agent else EDGE_TTS_VOICE
        self.elevenlabs_model = ELEVENLABS_MODEL_ID
        self.work_dir = OUTPUT_DIR / topic_slug / "audio"
        self.work_dir.mkdir(parents=True, exist_ok=True)
        # Characters actually sent to the TTS vendor this run. Cache hits are
        # deliberately excluded: a re-used segment was already paid for, and
        # counting it again would overstate the run's cost.
        self.characters_synthesized = 0

    # ------------------------------------------------------------------ TTS

    async def _tts_edge(self, text: str, voice: str, out_path: Path):
        communicate = edge_tts.Communicate(text, voice)
        await communicate.save(str(out_path))

    def _tts_elevenlabs(self, text: str, voice_id: str, out_path: Path):
        from elevenlabs import ElevenLabs, VoiceSettings  # lazy import

        client = ElevenLabs(api_key=ELEVENLABS_API_KEY)
        # eleven_v3 accepts only the stability presets 0.0 / 0.5 / 1.0
        # (creative / natural / robust); the others take any value.
        stability = 0.5 if self.elevenlabs_model == "eleven_v3" else 0.45
        try:
            audio = client.text_to_speech.convert(
                voice_id=voice_id,
                text=text,
                model_id=self.elevenlabs_model,
                voice_settings=VoiceSettings(stability=stability, similarity_boost=0.82),
            )
            with open(out_path, "wb") as f:
                for chunk in audio:
                    f.write(chunk)
        except Exception as e:
            status = getattr(e, "status_code", None)
            if status is None:
                raise
            out_path.unlink(missing_ok=True)   # never leave half a segment in the cache
            raise VoiceUnavailable(_tts_refusal(voice_id, status, getattr(e, "body", None))) from None

    def _elevenlabs_voice_for(self, voice_role: str) -> str:
        """The voice id a segment of ``voice_role`` is read in. Never a
        built-in id: an unset secondary voice raises (verify_voice stops such a
        run before it spends anything; this guards every other entry point)."""
        if voice_role == "main":
            return self.main_elevenlabs_voice
        secondary = self.secondary_elevenlabs_voice
        if secondary == NARRATOR:
            return self.main_elevenlabs_voice
        if not secondary:
            raise VoiceUnavailable(
                "The script has a [VOICE:secondary] line but this channel has no second "
                "ElevenLabs voice chosen. Pick one in the Command Center (Agents → Voice → "
                "Quote voice), or choose 'quotes in the narrator's voice'."
            )
        return secondary

    def _render_segment(self, text: str, voice_role: str) -> Path:
        """Render a single TTS segment, return path to .mp3.

        Keyed by content, not by position. A positional index silently served
        stale audio whenever a re-run produced a different script: the narration
        would then contradict its own subtitles and SFX placement, with nothing
        in the log to say so.
        """
        # The voice is part of the cache key: two channels narrating the same
        # sentence must not share one rendered segment.
        # So is the ElevenLabs model: switching models must re-render, not
        # reuse the old model's audio.
        voice_key = f"{self.tts_provider}:{self.main_elevenlabs_voice}:{self.main_edge_voice}"
        if self.tts_provider == "elevenlabs" and voice_role != "main":
            # Which second voice read it is part of what the segment sounds like.
            voice_key += f":{self._elevenlabs_voice_for(voice_role)}"
        if self.tts_provider == "elevenlabs" and self.elevenlabs_model != "eleven_multilingual_v2":
            voice_key += f":{self.elevenlabs_model}"
        digest = hashlib.sha1(f"{voice_key}:{voice_role}:{text}".encode("utf-8")).hexdigest()[:12]
        out = self.work_dir / f"seg_{digest}_{voice_role}.mp3"
        if out.exists():
            return out
        self.characters_synthesized += len(text)
        if self.tts_provider == "elevenlabs":
            self._tts_elevenlabs(text, self._elevenlabs_voice_for(voice_role), out)
        else:
            voice = self.main_edge_voice if voice_role == "main" else EDGE_TTS_SECONDARY_VOICE
            asyncio.run(self._tts_edge(text, voice, out))
        return out

    def synthesize_text(self, text: str, out_path: Path, voice_role: str = "main") -> Path:
        """Render one narration segment for `text` to `out_path`, using this
        channel's configured voice — the same per-segment TTS path build() uses.

        Narration only: no SFX or music bed (that is build()'s job). This is the
        clean public seam modules/providers.VoiceProvider wraps, so a caller can
        synthesize a line without reaching into _render_segment or reconstructing
        the mixer's cache layout."""
        src = self._render_segment(text, voice_role)
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        if Path(src).resolve() != out_path.resolve():
            shutil.copyfile(src, out_path)
        return out_path

    def render_narration(self, script: Script) -> tuple[AudioSegment, list[dict]]:
        """
        Returns (full_narration_audio, word_timestamps_list).
        word_timestamps are approximate — exact ones come from Whisper later.
        Inserts [PAUSE] silences between segments.
        """
        combined = AudioSegment.empty()
        timeline = []  # [{start_ms, end_ms, section_name}]

        for section in script.sections:
            section_audio = AudioSegment.empty()

            # Walk speech and pauses in written order so each [PAUSE:n] lands
            # where the script put it, not lumped at the end of the section.
            for event in section.tts_timeline():
                if event["kind"] == "pause":
                    section_audio += AudioSegment.silent(
                        duration=int(event["duration"] * 1000), frame_rate=44100
                    )
                    continue
                path = self._render_segment(event["text"], event["voice"])
                part = AudioSegment.from_file(path)
                part = normalize(part) + (20 * (NARRATOR_VOLUME - 1))
                section_audio += part

            start_ms = len(combined)
            combined += section_audio
            timeline.append({
                "section": section.name,
                "start_ms": start_ms,
                "end_ms": len(combined),
            })
            logger.debug("Section '%s': %.1fs", section.name, len(section_audio) / 1000)

        narration_path = self.work_dir / "narration.mp3"
        combined.export(narration_path, format="mp3", bitrate="192k")
        logger.info("Narration rendered: %.1fs", len(combined) / 1000)
        return combined, timeline

    # ------------------------------------------------------------------ SFX

    def _load_sfx(self, name: str) -> AudioSegment | None:
        for ext in ("mp3", "wav", "ogg"):
            path = SFX_DIR / f"{name}.{ext}"
            if path.exists():
                return AudioSegment.from_file(path)
        logger.warning("SFX not found: %s", name)
        return None

    def mix_sfx(self, base: AudioSegment, timeline: list[dict], script: Script) -> AudioSegment:
        """Overlay SFX cues onto base audio at approximate positions."""
        result = base
        total_ms = len(base)

        # Collect all sfx with absolute time estimates
        all_cues = []
        for i, section in enumerate(script.sections):
            if i >= len(timeline):
                break
            sec_start = timeline[i]["start_ms"]
            sec_end = timeline[i]["end_ms"]
            sec_dur = sec_end - sec_start
            narration_len = max(len(section.narration), 1)

            for cue in section.sfx_cues:
                rel = cue["char_pos"] / narration_len
                abs_ms = int(sec_start + rel * sec_dur)
                all_cues.append({"name": cue["name"], "ms": abs_ms})

        for cue in all_cues:
            sfx = self._load_sfx(cue["name"])
            if sfx is None:
                continue
            sfx = sfx + (20 * (SFX_VOLUME - 1))
            pos = min(cue["ms"], total_ms - 100)
            result = result.overlay(sfx, position=pos)
            logger.debug("SFX '%s' at %.1fs", cue["name"], pos / 1000)

        return result

    # ------------------------------------------------------------------ Music

    def _load_music(self, cue: str) -> AudioSegment | None:
        for ext in ("mp3", "wav"):
            path = MUSIC_DIR / f"{cue}.{ext}"
            if path.exists():
                return AudioSegment.from_file(path)
        # fallback: any music file
        files = list(MUSIC_DIR.glob("*.mp3")) + list(MUSIC_DIR.glob("*.wav"))
        if files:
            return AudioSegment.from_file(files[0])
        logger.warning("No music file found for cue: %s", cue)
        return None

    def mix_music(self, base: AudioSegment, timeline: list[dict], script: Script) -> AudioSegment:
        """Build a dynamic music layer that changes volume per cue, overlay onto base."""
        total_ms = len(base)

        # Resolve music cue times
        cue_times = []
        for i, section in enumerate(script.sections):
            if i >= len(timeline):
                break
            sec_start = timeline[i]["start_ms"]
            sec_dur = timeline[i]["end_ms"] - sec_start
            narration_len = max(len(section.narration), 1)
            for mc in section.music_cues:
                rel = mc["char_pos"] / narration_len
                abs_ms = int(sec_start + rel * sec_dur)
                cue_times.append({"cue": mc["cue"], "ms": abs_ms})

        # Default: intro_high → story_low if no explicit cues
        if not cue_times:
            cue_times = [
                {"cue": "intro_high", "ms": 0},
                {"cue": "story_low", "ms": 8000},
            ]

        cue_times.sort(key=lambda x: x["ms"])

        # Build one continuous bed per cue interval, so climax_high and outro
        # are actually heard rather than only contributing a volume number.
        result_music = AudioSegment.empty()
        prev_ms = 0
        prev_cue = cue_times[0]["cue"]

        def bed(cue: str, length_ms: int) -> AudioSegment | None:
            """Track for `cue`, tiled to `length_ms`, at that cue's volume."""
            if length_ms <= 0:
                return AudioSegment.empty()
            track = self._load_music(cue)
            if not track:  # missing file, or a truncated one — len() would be 0
                return None
            tiled = track * ((length_ms // len(track)) + 2)
            return tiled[:length_ms] + MUSIC_VOLUME_MAP.get(cue, -18)

        # Each interval takes the volume of the cue that OPENED it — the cue
        # being iterated closes it. Reading this cue's volume instead shifts
        # every level one interval late and drops the first cue entirely.
        for ct in cue_times:
            piece = bed(prev_cue, ct["ms"] - prev_ms)
            if piece is None:
                return base
            result_music += piece
            prev_ms, prev_cue = ct["ms"], ct["cue"]

        piece = bed(prev_cue, total_ms - prev_ms)
        if piece is None:
            return base
        result_music += piece

        return base.overlay(result_music[:total_ms])

    # ------------------------------------------------------------------ Pattern Interrupt

    def add_pattern_interrupts(self, audio: AudioSegment) -> AudioSegment:
        """Every ~35s inject a subtle whoosh to keep subconscious attention."""
        whoosh = self._load_sfx("whoosh")
        if whoosh is None:
            return audio
        whoosh_soft = whoosh - 8  # quieter
        result = audio
        pos = PATTERN_INTERRUPT_INTERVAL * 1000
        while pos < len(audio) - 2000:
            result = result.overlay(whoosh_soft, position=int(pos))
            pos += PATTERN_INTERRUPT_INTERVAL * 1000
        return result

    # ------------------------------------------------------------------ Master

    def build(self, script: Script) -> tuple[Path, list[dict]]:
        """Full pipeline: render → mix sfx → mix music → pattern interrupts → export."""
        logger.info("Building audio for topic: %s", self.slug)

        narration, timeline = self.render_narration(script)
        mixed = self.mix_sfx(narration, timeline, script)
        mixed = self.mix_music(mixed, timeline, script)
        mixed = self.add_pattern_interrupts(mixed)

        out = self.work_dir / "final_audio.mp3"
        mixed.export(out, format="mp3", bitrate="192k")
        logger.info("Final audio: %s (%.1fs)", out, len(mixed) / 1000)
        return out, timeline
