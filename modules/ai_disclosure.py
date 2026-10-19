"""Should this video carry the "altered or synthetic content" label?

One pure rule, used by every place that publishes a video, so YouTube, Instagram
Reels and TikTok never disagree about the same cut.

The platforms ask the creator to say so when a video contains realistic
AI-generated or AI-altered media. YouTube's own help page ("Disclosing use of
altered or synthetic content", https://support.google.com/youtube/answer/14328491)
names the cases that must be disclosed: content that "makes a real person appear
to say or do something they didn't do", "alters footage of a real event or
place", "generates a realistic scene that didn't actually occur", or "creates
music that's the main focus of the video". It exempts content that is "not
realistic" (its example is an animated missile in a fully animated video),
"minor, primarily aesthetic" edits, and production help such as using generative
AI "to create or improve a video outline, script, thumbnail, title, or
infographic", caption creation and idea generation. It also lists "cloning one's
own voice to create voice overs or dubs" as not requiring disclosure, and says
creators "who consistently choose not to disclose this information may be
subject to manual application of a label" (and, for repeated non-disclosure,
penalties up to suspension from the YouTube Partner Program). The lists are
stated to be non-exhaustive. The API field is ``status.containsSyntheticMedia``
on ``videos.insert`` / ``videos.update``
(https://developers.google.com/youtube/v3/docs/videos).

What a channel can set (``agent_config``, no migration):

* ``ai_disclosure``: ``auto`` (default) | ``always`` | ``never``.
* ``ai_disclosure_voice``: what the narrator's voice is, because the pipeline
  cannot hear it: ``generic`` (default; the provider's stock voices or a generic
  text-to-speech voice) | ``own_clone`` (a clone of the channel owner's own
  voice) | ``real_person`` (a voice that sounds like, or clones, another real
  person). Anything else is read as ``real_person``: a typo must not switch a
  disclosure off.
* ``ai_disclosure_line``: ``false`` stops the description / caption line (the
  platform flag is still sent). Default true.
* ``ai_disclosure_text``: the line's wording; empty means the standard wording
  in the channel's language (en / ru / uz, English for any other language).

``auto`` is deliberately conservative where the page cannot be applied from
pixels: this code cannot tell whether a generated clip looks realistic, so every
generated clip or still counts as realistic. A channel whose AI pictures are
clearly unrealistic (fully animated, cartoon) and that wants the page's
"not realistic" exemption says so with ``never``; that is the owner's call.

Pure: no network, no disk, never raises on bad input.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Mapping, Optional

MODE_AUTO = "auto"
MODE_ALWAYS = "always"
MODE_NEVER = "never"
MODES = (MODE_AUTO, MODE_ALWAYS, MODE_NEVER)

VOICE_GENERIC = "generic"
VOICE_OWN_CLONE = "own_clone"
VOICE_REAL_PERSON = "real_person"
VOICES = (VOICE_GENERIC, VOICE_OWN_CLONE, VOICE_REAL_PERSON)

# The closed vocabulary of reasons (the panel has a sentence for each).
R_GENERATED_VIDEO = "generated_video"
R_GENERATED_IMAGES = "generated_images"
R_AI_PRESENTER = "ai_presenter"
R_REAL_PERSON_VOICE = "real_person_voice"
R_PROVENANCE_UNKNOWN = "provenance_unknown"
R_MODE_ALWAYS = "mode_always"
R_MODE_NEVER = "mode_never"
R_NONE = "no_synthetic_media"
REASONS = (R_GENERATED_VIDEO, R_GENERATED_IMAGES, R_AI_PRESENTER, R_REAL_PERSON_VOICE,
           R_PROVENANCE_UNKNOWN, R_MODE_ALWAYS, R_MODE_NEVER, R_NONE)

#: The event the pipeline records at upload (``system_events.event``); the
#: Command Center reads it back for the review panel.
EVENT = "video.ai_disclosure"

LINE_MAX = 300

# Machine drafts for ru / uz: have a native reader confirm them (docs/AI_DISCLOSURE.md).
STANDARD_LINES = {
    "en": "This video contains realistic AI-generated or AI-altered content.",
    "ru": "В этом видео есть реалистичный контент, созданный или изменённый с помощью ИИ.",
    "uz": "Ushbu videoda sun'iy intellekt yordamida yaratilgan yoki o'zgartirilgan realistik kontent mavjud.",
}

_LANGS = {"english": "en", "russian": "ru", "uzbek": "uz", "en": "en", "ru": "ru", "uz": "uz"}
_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")


def normalize_mode(value) -> str:
    """``auto`` unless the value is exactly one of the three words (case and
    surrounding space ignored). An unreadable value is ``auto``, never ``never``."""
    v = value.strip().lower() if isinstance(value, str) else ""
    return v if v in MODES else MODE_AUTO


def normalize_voice(value) -> str:
    """``generic`` when absent; a value that is not one of the three words is
    ``real_person`` (the conservative reading)."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return VOICE_GENERIC
    v = value.strip().lower() if isinstance(value, str) else ""
    return v if v in VOICES else VOICE_REAL_PERSON


def normalize_line_flag(value) -> bool:
    """Only an explicit false drops the line."""
    return value is not False


def normalize_text(value) -> str:
    """The channel's own wording: one line, no angle brackets (YouTube rejects
    them), at most 300 characters; empty means "use the standard wording"."""
    if not isinstance(value, str):
        return ""
    text = _CONTROL.sub(" ", value).replace("<", "").replace(">", "")
    return " ".join(text.split())[:LINE_MAX].strip()


def language_code(language) -> str:
    """``en`` / ``ru`` / ``uz`` for a channel language ("russian", "ru",
    "uz-UZ"); English for anything else."""
    if not isinstance(language, str):
        return "en"
    key = language.strip().lower()
    return _LANGS.get(key) or _LANGS.get(key.split("-")[0], "en")


def line_for(language, custom: str = "") -> str:
    """The disclosure line: the channel's own wording, else the standard one."""
    return normalize_text(custom) or STANDARD_LINES[language_code(language)]


@dataclass(frozen=True)
class Signals:
    """What is known about the cut. ``known`` False means the provenance of the
    pictures could not be read (no manifest, no record): ``auto`` then labels."""

    known: bool = True
    generated_clips: int = 0
    generated_stills: int = 0
    presenter: bool = False
    voice: str = VOICE_GENERIC

    def to_dict(self) -> dict:
        return {"known": self.known, "generated_clips": self.generated_clips,
                "generated_stills": self.generated_stills, "presenter": self.presenter, "voice": self.voice}

    @staticmethod
    def from_dict(d) -> Optional["Signals"]:
        """Back from an event's metadata; None when it is not a readable record."""
        if not isinstance(d, Mapping):
            return None

        def count(key):
            v = d.get(key)
            return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None

        clips, stills = count("generated_clips"), count("generated_stills")
        if clips is None or stills is None or not isinstance(d.get("presenter"), bool):
            return None
        return Signals(known=d.get("known") is not False, generated_clips=clips, generated_stills=stills,
                       presenter=d["presenter"], voice=normalize_voice(d.get("voice")))


@dataclass(frozen=True)
class Decision:
    label: bool
    mode: str
    reasons: tuple
    line: str = ""

    def to_metadata(self, language="", signals: Optional[Signals] = None) -> dict:
        """The event's metadata: the decision and the facts it was made from
        (counts and words only; never a prompt, a path or a key)."""
        out = {"label": self.label, "mode": self.mode, "reasons": list(self.reasons),
               "line": bool(self.line), "language": language_code(language)}
        if signals is not None:
            out["signals"] = signals.to_dict()
        return out


def decide(mode, signals: Signals, *, language="", line_enabled: bool = True, custom_text: str = "") -> Decision:
    """The label decision. ``mode`` is the channel's ``ai_disclosure``.

    ``auto`` labels when any of these holds (each is a documented reason):
    a generated video clip, a generated still, an AI presenter, a voice that
    is another real person's (or sounds like one), or provenance that could not
    be read. Stock footage and stock stills with a generic or own-voice
    narration are not labelled; neither is a script written with a model (the
    page exempts script and outline help).
    """
    mode = normalize_mode(mode)
    if mode == MODE_NEVER:
        label, reasons = False, (R_MODE_NEVER,)
    elif mode == MODE_ALWAYS:
        label, reasons = True, (R_MODE_ALWAYS,)
    else:
        found = []
        if not signals.known:
            found.append(R_PROVENANCE_UNKNOWN)
        if signals.generated_clips > 0:
            found.append(R_GENERATED_VIDEO)
        if signals.generated_stills > 0:
            found.append(R_GENERATED_IMAGES)
        if signals.presenter:
            found.append(R_AI_PRESENTER)
        if normalize_voice(signals.voice) == VOICE_REAL_PERSON:
            found.append(R_REAL_PERSON_VOICE)
        label, reasons = bool(found), tuple(found) or (R_NONE,)
    line = line_for(language, custom_text) if (label and line_enabled) else ""
    return Decision(label=label, mode=mode, reasons=reasons, line=line)


# ── where the facts come from ────────────────────────────────────────────────


def signals_from_manifest(manifest, *, presenter: bool = False, voice: str = VOICE_GENERIC) -> Signals:
    """Facts from a stored Video IR (``videos.manifest``): the assets recorded as
    ``generated``. Any generated asset of the run counts, whether or not the
    final cut placed it (the planner's placement is advisory). A manifest that
    is missing or unreadable gives ``known=False``."""
    assets = manifest.get("assets") if isinstance(manifest, Mapping) else None
    if not isinstance(assets, list):
        return Signals(known=False, presenter=presenter, voice=normalize_voice(voice))
    clips = stills = 0
    for a in assets:
        if not isinstance(a, Mapping) or a.get("source") != "generated":
            continue
        if a.get("kind") == "video":
            clips += 1
        elif a.get("kind") == "image":
            stills += 1
    return Signals(known=True, generated_clips=clips, generated_stills=stills,
                   presenter=presenter, voice=normalize_voice(voice))


def signals_from_events(events: Iterable) -> Optional[Signals]:
    """The newest recorded ``video.ai_disclosure`` event's signals (rows as the
    REST API returns them, newest first or last: ``ts`` decides), or None."""
    best = None
    for e in events or []:
        if not isinstance(e, Mapping) or e.get("event") != EVENT:
            continue
        meta = e.get("metadata")
        sig = Signals.from_dict(meta.get("signals") if isinstance(meta, Mapping) else None)
        if sig is None:
            continue
        ts = str(e.get("ts") or "")
        if best is None or ts >= best[0]:
            best = (ts, sig)
    return best[1] if best else None


def settings_of(agent) -> dict:
    """The channel's four settings from an ``AgentConfig`` (or anything with the
    same attributes), normalised."""
    return {
        "mode": normalize_mode(getattr(agent, "ai_disclosure", MODE_AUTO)),
        "voice": normalize_voice(getattr(agent, "ai_disclosure_voice", None)),
        "line_enabled": normalize_line_flag(getattr(agent, "ai_disclosure_line", True)),
        "custom_text": normalize_text(getattr(agent, "ai_disclosure_text", "")),
        "language": getattr(agent, "language", "") or "",
    }


def decide_for(agent, signals: Signals) -> Decision:
    """``decide`` with a channel's own settings; the channel's voice setting
    overrides whatever voice the signals carried (a setting changed since the
    record was written applies to the next publish)."""
    s = settings_of(agent)
    sig = Signals(known=signals.known, generated_clips=signals.generated_clips,
                  generated_stills=signals.generated_stills, presenter=signals.presenter, voice=s["voice"])
    return decide(s["mode"], sig, language=s["language"], line_enabled=s["line_enabled"], custom_text=s["custom_text"])


def for_run(agent, *, generated_clips, generated_stills, presenter) -> tuple:
    """``(Decision, Signals)`` for a run that has just built its cut: the counts
    are what the run itself generated (clips, stills, a presenter), the voice is
    the channel's declaration. Counts that are not whole numbers read as 0."""

    def count(v):
        return v if isinstance(v, int) and not isinstance(v, bool) and v > 0 else 0

    signals = Signals(known=True, generated_clips=count(generated_clips), generated_stills=count(generated_stills),
                      presenter=bool(presenter), voice=normalize_voice(getattr(agent, "ai_disclosure_voice", None)))
    return decide_for(agent, signals), signals


def append_line(text: str, line: str, *, limit: int, measure=len) -> str:
    """``text`` + a blank line + ``line``, only when it fits ``limit`` (by
    ``measure``) and the line is not already there; otherwise ``text`` unchanged.
    The platform flag is the declaration; the line is a courtesy, so it is the
    line that is dropped, never the creator's own words."""
    text = text or ""
    line = (line or "").strip()
    if not line or line in text:
        return text
    candidate = f"{text.rstrip()}\n\n{line}" if text.strip() else line
    return candidate if measure(candidate) <= limit else text


__all__ = [
    "MODES", "VOICES", "REASONS", "EVENT", "STANDARD_LINES", "Signals", "Decision", "decide", "decide_for",
    "normalize_mode", "normalize_voice", "normalize_text", "normalize_line_flag", "language_code", "line_for",
    "signals_from_manifest", "signals_from_events", "settings_of", "append_line",
]
