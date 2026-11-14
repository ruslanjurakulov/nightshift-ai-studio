"""Voice to 2D video: a person's own narration in, a 9:16 motion-graphics explainer out.

The recording is the clock. Its words (Whisper, or a word track the caller already has)
are split into sentences; each sentence becomes one scene with a small kicker line, a big
headline with one marked word, one visual from a CLOSED catalogue, and an italic accent
line. The Remotion composition ``VoiceExplainer`` (video-engine/src/explainer/) draws the
whole video in one render, narration, music and sound effects included.

Two planners fill the scenes, and the caller picks one; neither stands in for the other:

* ``plan_rules``: deterministic, free, offline. Plain but never wrong about timing.
* ``plan_model``: a language model writes the kicker/headline/accent and picks the
  visuals. Its answer is validated against the catalogue (:func:`validate_scene`), and an
  answer that does not fit is a refusal (:class:`PlanRejected`), never a quiet switch to
  the rules planner (CLAUDE.md rule 4).

This module spends nothing and talks to no provider by itself: transcription and the
model are passed in. Two callers wire it: tools/voice_to_video.py (the operator's command)
and modules/capabilities/voice_video.py (the Studio's paid creative job, migration 0170,
rules planner only; docs/VOICE_EXPLAINER.md).
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, List, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

#: Mirrors video-engine/src/explainer/looks.ts LOOK_IDS (tests pin the two).
LOOKS = ("dusk", "midnight", "golden", "neon", "paper")
#: Mirrors the closed catalogue in video-engine/src/explainer/types.ts.
VISUAL_KINDS = ("none", "card", "stat", "progress", "characters", "emoji", "checklist", "chat")
POSES = ("stand", "wave", "point", "think", "cheer", "sad", "sit")
SETTINGS = ("street", "room", "office", "stage")
PROPS = ("none", "laptop", "phone", "coin", "chart", "book")
MOODS = ("worried", "happy", "shocked", "thinking", "angry", "calm")
TONES = ("normal", "good", "bad")

COMPOSITION = "VoiceExplainer"
ENGINE_DIR = Path(__file__).resolve().parent.parent / "video-engine"
#: The longest recording a render takes. A longer one is refused before anything runs:
#: one Remotion render holds every frame's scene in one process.
MAX_SECONDS = 600.0

# Text limits the layout is drawn for: beyond them a line wraps into the visual.
MAX_KICKER = 48
MAX_HEADLINE = 28
MAX_ACCENT = 48
MAX_ROWS = 6
MAX_ITEMS = 5
MAX_MESSAGES = 4
MAX_CAST = 3
#: Nested text limits. The validator and the model's prompt both read these, so the model is told exactly what
#: will be refused.
LIMITS = {
    "card_title": 32, "card_subtitle": 40, "row_label": 28, "row_value": 14, "total_label": 20, "total_value": 14,
    "stat_value": 12, "stat_label": 40, "progress_label": 28, "progress_note": 32, "checklist_item": 24, "message": 60,
}


class ExplainerError(ValueError):
    """A request the explainer cannot honour. The message names the fix."""


class PlanRejected(ExplainerError):
    """The model's plan does not fit the catalogue. Never replaced by the rules planner."""


class RenderFailed(ExplainerError):
    """Remotion ran and did not produce the video. Not the recording's fault: a paid caller words it as the engine's."""


class RenderTimeout(RenderFailed):
    """The render ran out of time and was stopped (a busy or too small machine, not a bad recording)."""


@dataclass(frozen=True)
class Word:
    text: str
    start_s: float
    end_s: float


@dataclass
class Sentence:
    words: List[Word]

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)

    @property
    def start_s(self) -> float:
        return self.words[0].start_s

    @property
    def end_s(self) -> float:
        return self.words[-1].end_s


@dataclass
class Scene:
    id: str
    start_s: float
    end_s: float
    kicker: str
    headline: str
    accent: str
    visual: dict = field(default_factory=lambda: {"kind": "none"})

    def to_dict(self) -> dict:
        return {"id": self.id, "start_s": round(self.start_s, 3), "end_s": round(self.end_s, 3), "kicker": self.kicker,
                "headline": self.headline, "accent": self.accent, "visual": self.visual}


# ── words ─────────────────────────────────────────────────────────────────

def _num(v) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def normalize_words(raw: Iterable[Mapping]) -> List[Word]:
    """Whisper's ``{word,start,end}``, the captions track's ``{t,s,e}`` or our own
    ``{text,start_s,end_s}`` -> ordered :class:`Word` s. A word without both times or
    with no text is dropped (it cannot be placed); times that go backwards are clamped
    forward so captions never jump back."""
    out: List[Word] = []
    last = 0.0
    for r in raw or []:
        if not isinstance(r, Mapping):
            continue
        text = str(r.get("text", r.get("word", r.get("t", ""))) or "").strip()
        s = _num(r.get("start_s", r.get("start", r.get("s"))))
        e = _num(r.get("end_s", r.get("end", r.get("e"))))
        if not text or s is None or e is None:
            continue
        s = max(s, last)
        e = max(e, s + 0.01)
        out.append(Word(text, s, e))
        last = s
    return out


_END = re.compile(r"[.!?…]+[\"'»”)]*$")
_SOFT = re.compile(r"[,;:—–-]+[\"'»”)]*$")


def split_sentences(words: Sequence[Word], *, max_s: float = 6.5, min_s: float = 1.6) -> List[Sentence]:
    """Sentences on the recording's own punctuation, with two corrections a viewer needs:
    a run longer than ``max_s`` breaks at its last comma (or, failing that, where it
    reaches the limit), so no scene holds one headline for half a minute; and a piece
    shorter than ``min_s`` joins the one before it, so no scene flashes past."""
    pieces: List[List[Word]] = []
    cur: List[Word] = []
    for w in words:
        cur.append(w)
        dur = cur[-1].end_s - cur[0].start_s
        if _END.search(w.text):
            pieces.append(cur)
            cur = []
        elif dur >= max_s:
            cut = max((i for i, x in enumerate(cur[:-1]) if _SOFT.search(x.text)), default=None)
            if cut is not None and cut >= 1:
                pieces.append(cur[: cut + 1])
                cur = cur[cut + 1:]
            else:
                pieces.append(cur)
                cur = []
    if cur:
        pieces.append(cur)
    merged: List[List[Word]] = []
    for p in pieces:
        if merged and (p[-1].end_s - p[0].start_s) < min_s:
            merged[-1].extend(p)
        else:
            merged.append(p)
    if len(merged) > 1 and (merged[0][-1].end_s - merged[0][0].start_s) < min_s:
        merged[1] = merged[0] + merged[1]
        merged.pop(0)
    return [Sentence(p) for p in merged]


def fit_words(words: Sequence[Word], duration_s: float, *, slack_s: float = 0.5) -> List[Word]:
    """The words as the recording can hold them. ffprobe's length of a VBR mp3 is an estimate and Whisper's last word
    can overshoot it a little: an end within ``slack_s`` past the recording is clamped to it. A word further out is a
    track that does not belong to this recording (another take) and is refused: the render would stop on it after
    the transcription and the planner were paid for."""
    out = []
    for w in words:
        if w.start_s >= duration_s or w.end_s > duration_s + slack_s:
            raise ExplainerError(f"the word track runs past the recording ({w.text!r} at {w.start_s:.2f}-{w.end_s:.2f} s, "
                                 f"the recording is {duration_s:.2f} s): is it this recording's track?")
        out.append(Word(w.text, w.start_s, min(w.end_s, duration_s)))
    return out


def scene_windows(sentences: Sequence[Sentence], duration_s: float) -> List[tuple]:
    """Each scene runs from its sentence's first word to the next sentence's first word:
    the cut lands as the next sentence starts, never in the middle of a word. The first
    scene starts at 0, the last ends with the recording."""
    out = []
    for i, s in enumerate(sentences):
        start = 0.0 if i == 0 else s.start_s
        end = sentences[i + 1].start_s if i + 1 < len(sentences) else duration_s
        if not 0 <= start < end <= duration_s:
            raise ExplainerError(f"scene {i} would run {start:.2f}-{end:.2f} s on a {duration_s:.2f} s recording: "
                                 "fit the words to the recording first (fit_words)")
        out.append((start, end))
    return out


# ── the catalogue ─────────────────────────────────────────────────────────

def _text(v, limit: int, what: str, *, required: bool = True) -> str:
    s = str(v or "").strip()
    if required and not s:
        raise PlanRejected(f"{what} is empty")
    if len(s) > limit:
        raise PlanRejected(f"{what} is {len(s)} characters, the layout holds {limit}: {s[:limit]}…")
    return s


def _one_of(v, allowed: Sequence[str], what: str) -> str:
    s = str(v or "").strip().lower()
    if s not in allowed:
        raise PlanRejected(f"{what} {v!r} is not one of {', '.join(allowed)}")
    return s


def validate_visual(v: Mapping) -> dict:
    """One visual, checked against the closed catalogue and returned in the renderer's
    exact shape. Anything else is a refusal naming the field."""
    if not isinstance(v, Mapping):
        raise PlanRejected("visual is not an object")
    kind = _one_of(v.get("kind"), VISUAL_KINDS, "visual kind")
    if kind == "none":
        return {"kind": "none"}
    if kind == "card":
        rows = v.get("rows") or []
        if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_ROWS:
            raise PlanRejected(f"a card has 1 to {MAX_ROWS} rows")
        if not all(isinstance(r, Mapping) for r in rows):
            raise PlanRejected("a card row is not an object")
        out = {"kind": "card", "title": _text(v.get("title"), LIMITS["card_title"], "card title"),
               "rows": [{"label": _text(r.get("label"), LIMITS["row_label"], "row label"),
                         "value": _text(r.get("value"), LIMITS["row_value"], "row value"),
                         "tone": _one_of(r.get("tone") or "normal", TONES, "row tone")} for r in rows]}
        if v.get("subtitle"):
            out["subtitle"] = _text(v.get("subtitle"), LIMITS["card_subtitle"], "card subtitle")
        if v.get("total"):
            t = v["total"]
            if not isinstance(t, Mapping):
                raise PlanRejected("card total is not an object")
            out["total"] = {"label": _text(t.get("label"), LIMITS["total_label"], "total label"),
                            "value": _text(t.get("value"), LIMITS["total_value"], "total value")}
        return out
    if kind == "stat":
        return {"kind": "stat", "value": _text(v.get("value"), LIMITS["stat_value"], "stat value"),
                "label": _text(v.get("label"), LIMITS["stat_label"], "stat label")}
    if kind == "progress":
        pct = _num(v.get("percent"))
        if pct is None or not 0 <= pct <= 100:
            raise PlanRejected(f"progress percent {v.get('percent')!r} is not 0 to 100")
        out = {"kind": "progress", "label": _text(v.get("label"), LIMITS["progress_label"], "progress label"), "percent": pct}
        if v.get("note"):
            out["note"] = _text(v.get("note"), LIMITS["progress_note"], "progress note")
        return out
    if kind == "characters":
        cast = v.get("cast") or []
        if not isinstance(cast, list) or not 1 <= len(cast) <= MAX_CAST:
            raise PlanRejected(f"a character scene has 1 to {MAX_CAST} people")
        members = []
        for m in cast:
            if not isinstance(m, Mapping):
                raise PlanRejected("a cast member is not an object")
            color = _num(m.get("color"))
            members.append({"pose": _one_of(m.get("pose"), POSES, "pose"),
                            "color": int(color) % 4 if color is not None else len(members) % 4})
        return {"kind": "characters", "setting": _one_of(v.get("setting"), SETTINGS, "setting"), "cast": members,
                "prop": _one_of(v.get("prop") or "none", PROPS, "prop")}
    if kind == "emoji":
        return {"kind": "emoji", "mood": _one_of(v.get("mood"), MOODS, "mood")}
    if kind == "checklist":
        items = v.get("items") or []
        if not isinstance(items, list) or not 1 <= len(items) <= MAX_ITEMS:
            raise PlanRejected(f"a checklist has 1 to {MAX_ITEMS} items")
        if not all(isinstance(i, str) for i in items):
            raise PlanRejected("a checklist item is not text")
        return {"kind": "checklist", "items": [_text(i, LIMITS["checklist_item"], "checklist item") for i in items]}
    msgs = v.get("messages") or []
    if not isinstance(msgs, list) or not 1 <= len(msgs) <= MAX_MESSAGES:
        raise PlanRejected(f"a chat has 1 to {MAX_MESSAGES} messages")
    # An empty bubble panel is not a scene: a message that is not an object is refused, never dropped.
    if not all(isinstance(m, Mapping) for m in msgs):
        raise PlanRejected("a chat message is not an object")
    return {"kind": "chat", "messages": [{"side": _one_of(m.get("side"), ("left", "right"), "message side"),
                                          "text": _text(m.get("text"), LIMITS["message"], "message")} for m in msgs]}


def validate_scene(raw: Mapping, *, index: int) -> dict:
    """The model-written part of one scene (no times: those come from the recording)."""
    if not isinstance(raw, Mapping):
        raise PlanRejected(f"scene {index} is not an object")
    headline = _text(raw.get("headline"), MAX_HEADLINE + 2, f"scene {index} headline")
    stars = headline.count("*")
    if stars not in (0, 2) or (stars == 2 and not re.fullmatch(r"[^*]*\*[^*]+\*[^*]*", headline)):
        raise PlanRejected(f"scene {index} headline marks its accent word with one pair of *stars*: {headline}")
    if len(headline) - stars > MAX_HEADLINE:  # the stars are not drawn; the letters must fit
        raise PlanRejected(f"scene {index} headline is {len(headline) - stars} characters, the layout holds {MAX_HEADLINE}")
    return {"kicker": _text(raw.get("kicker"), MAX_KICKER, f"scene {index} kicker", required=False),
            "headline": headline,
            "accent": _text(raw.get("accent"), MAX_ACCENT, f"scene {index} accent", required=False),
            "visual": validate_visual(raw.get("visual") or {"kind": "none"})}


# ── planners ──────────────────────────────────────────────────────────────

_STOP = {"the", "a", "an", "and", "or", "of", "to", "in", "on", "is", "it", "this", "that", "for", "with", "you", "your",
         "va", "bu", "u", "bilan", "uchun", "esa", "ham", "siz", "biz", "men", "edi", "deb", "i", "в", "и", "на", "это",
         "что", "с", "не", "по", "как", "я", "вы", "мы"}
#: A spoken number as written. Space-grouped thousands come first ("10 000", "1 500 000": the Uzbek and Russian way
#: of writing them), then plain numbers with their decimal or thousands marks. Sentence punctuation never sticks to it.
_NUMBER = re.compile(r"[$€£₽]?\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?%?|[$€£₽]?\d+(?:[.,]\d+)*%?[$€£₽]?")


def spoken_number(text: str) -> Optional[str]:
    """The first number the sentence says, exactly as written, or None. A counter showing a number the narration did
    not say is worse than no counter (CLAUDE.md rule 5): what does not fit the counter is left out."""
    m = _NUMBER.search(text)
    if not m:
        return None
    value = m.group(0).strip()
    return value if len(value) <= LIMITS["stat_value"] else None


def _clean(w: str) -> str:
    # Stars mark the headline's accent word, so a word's own (a censored "f***") would break the marking.
    return re.sub(r"^[\"'«“(]+|[\"'»”).,!?;:…]+$", "", w.replace("*", ""))


def plan_rules(sentences: Sequence[Sentence]) -> List[dict]:
    """A plain plan from the words alone: the kicker is the sentence's opening, the
    headline its longest content word, the accent its last words, and the visual a
    stat when the sentence says a number, else a rotation of the character scenes and
    the reaction face. Deterministic: the same recording plans the same video."""
    plans = []
    rotation = [
        {"kind": "characters", "setting": "street", "prop": "none", "cast": [{"pose": "stand", "color": 0}, {"pose": "wave", "color": 1}]},
        {"kind": "emoji", "mood": "thinking"},
        {"kind": "characters", "setting": "office", "prop": "laptop", "cast": [{"pose": "point", "color": 2}]},
        {"kind": "characters", "setting": "room", "prop": "phone", "cast": [{"pose": "think", "color": 1}]},
        {"kind": "emoji", "mood": "shocked"},
        {"kind": "characters", "setting": "stage", "prop": "none", "cast": [{"pose": "cheer", "color": 3}]},
    ]
    for i, s in enumerate(sentences):
        words = [_clean(w.text) for w in s.words if _clean(w.text)]
        content = [w for w in words if w.lower() not in _STOP] or words
        key = max(content, key=len) if content else ""
        key = key[:MAX_HEADLINE]
        kicker = " ".join(words[:3])[:MAX_KICKER]
        accent = " ".join(words[-3:])[:MAX_ACCENT] if len(words) > 4 else ""
        number = spoken_number(s.text)
        if number:
            visual = {"kind": "stat", "value": number, "label": " ".join(words[:5])[:LIMITS["stat_label"]]}
        else:
            visual = rotation[i % len(rotation)]
        plans.append(validate_scene({"kicker": kicker, "headline": f"*{key}*" if key else "…", "accent": accent, "visual": visual}, index=i))
    return plans


PLANNER_SYSTEM = """You plan a vertical motion-graphics explainer drawn in code. For every sentence of a narration you
write one scene. You never change, add or drop sentences, and you answer with JSON only."""


def planner_prompt(sentences: Sequence[Sentence], language: str = "") -> str:
    lines = "\n".join(f"{i}. {s.text}" for i, s in enumerate(sentences))
    L = LIMITS
    return f"""Narration ({len(sentences)} sentences{', language: ' + language if language else ''}):
{lines}

Return a JSON array with exactly {len(sentences)} objects, in order, each:
{{"kicker": "<= {MAX_KICKER} chars, the sentence's set-up in its own language",
  "headline": "<= {MAX_HEADLINE} chars, 1-3 words, the punch; mark ONE word with *stars*",
  "accent": "<= {MAX_ACCENT} chars, a short italic echo, or empty",
  "visual": one of
    {{"kind":"characters","setting":"{'|'.join(SETTINGS)}","prop":"{'|'.join(PROPS)}","cast":[{{"pose":"{'|'.join(POSES)}","color":0-3}}] (1-{MAX_CAST} people)}}
    {{"kind":"card","title":"<= {L['card_title']}","subtitle":"<= {L['card_subtitle']}","rows":[{{"label":"<= {L['row_label']}","value":"<= {L['row_value']}","tone":"{'|'.join(TONES)}"}}] (1-{MAX_ROWS}),"total":{{"label":"<= {L['total_label']}","value":"<= {L['total_value']}"}}}}
    {{"kind":"stat","value":"<= {L['stat_value']}","label":"<= {L['stat_label']}"}}
    {{"kind":"progress","label":"<= {L['progress_label']}","percent":0-100,"note":"<= {L['progress_note']}"}}
    {{"kind":"emoji","mood":"{'|'.join(MOODS)}"}}
    {{"kind":"checklist","items":["<= {L['checklist_item']} each"] (1-{MAX_ITEMS})}}
    {{"kind":"chat","messages":[{{"side":"left|right","text":"<= {L['message']}"}}] (1-{MAX_MESSAGES})}}
    {{"kind":"none"}}
}}
All lengths are characters. A longer text, another value, or a missing field refuses the whole plan.
Use only numbers and facts the sentence itself says. Vary the visuals; a story beat gets characters, a price or list gets a card."""


def plan_model(sentences: Sequence[Sentence], gen: Callable[[str, Optional[str]], str], *, language: str = "") -> List[dict]:
    """The model's plan, validated scene by scene. A wrong count, bad JSON or a field
    outside the catalogue raises PlanRejected naming it: the caller decides what to do,
    and this function never substitutes the rules planner."""
    try:
        text = gen(planner_prompt(sentences, language), PLANNER_SYSTEM)
    except Exception as e:  # the provider's own error, named, not swallowed
        raise PlanRejected(f"the planner model failed ({type(e).__name__}: {str(e)[:200]})") from e
    raw = str(text or "").strip()
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw)
    try:
        data = json.loads(raw)
    except ValueError as e:
        raise PlanRejected(f"the planner answered something that is not JSON ({e.msg})") from None
    if isinstance(data, Mapping) and isinstance(data.get("scenes"), list):
        data = data["scenes"]
    if not isinstance(data, list) or len(data) != len(sentences):
        got = len(data) if isinstance(data, list) else type(data).__name__
        raise PlanRejected(f"the planner returned {got} scenes for {len(sentences)} sentences")
    return [validate_scene(d, index=i) for i, d in enumerate(data)]


def build_scenes(sentences: Sequence[Sentence], plans: Sequence[Mapping], duration_s: float) -> List[Scene]:
    if len(plans) != len(sentences):
        raise ExplainerError(f"{len(plans)} plans for {len(sentences)} sentences")
    return [Scene(f"e{i:03d}", start, end, p["kicker"], p["headline"], p["accent"], dict(p["visual"]))
            for i, ((start, end), p) in enumerate(zip(scene_windows(sentences, duration_s), plans))]


# ── sound ─────────────────────────────────────────────────────────────────

SFX_NEEDED = ("whoosh", "deep_boom")


def find_sfx(sfx_dir: Path) -> dict:
    """The effect files, or a refusal naming the fix. Cheap: callers run it before the transcription and the planner."""
    found = {n: next((p for ext in ("mp3", "wav") if (p := Path(sfx_dir) / f"{n}.{ext}").exists()), None) for n in SFX_NEEDED}
    missing = sorted(n for n, p in found.items() if p is None)
    if missing:
        raise ExplainerError(f"sound effects {', '.join(missing)} are not in {sfx_dir}: run `python tools/generate_assets.py`, "
                             "or turn effects off")
    return found


def sound_cues(scenes: Sequence[Scene], sfx_dir: Optional[Path]) -> tuple:
    """``(cues, files)``: a whoosh on every cut and a low hit under the first headline,
    as the composition's public paths, and the files :func:`render` copies for them.
    Asked for and missing is a refusal, not a silent video: ``sfx_dir=None`` is the only
    way to say "no effects"."""
    if sfx_dir is None:
        return [], {}
    found = find_sfx(sfx_dir)
    files = {f"sfx/{p.name}": p for p in found.values()}
    boom, whoosh = f"sfx/{found['deep_boom'].name}", f"sfx/{found['whoosh'].name}"
    cues = [{"src": boom, "at_s": 0.15, "volume": 0.35}]
    cues += [{"src": whoosh, "at_s": max(0.0, s.start_s - 0.12), "volume": 0.25} for s in scenes[1:]]
    return cues, files


# ── props and render ──────────────────────────────────────────────────────

def build_props(*, look: str, duration_s: float, words: Sequence[Word], scenes: Sequence[Scene], narration: str,
                music: str = "", music_volume: float = 0.08, sfx: Sequence[Mapping] = (), captions: bool = True,
                width: int = 1080, height: int = 1920, fps: int = 30) -> dict:
    """The VoiceExplainer props, exactly (video-engine/src/explainer/types.ts)."""
    if look not in LOOKS:
        raise ExplainerError(f"look {look!r} is not one of {', '.join(LOOKS)}")
    if not scenes:
        raise ExplainerError("no scenes: the recording has no words that could be timed")
    return {
        "width": int(width), "height": int(height), "fps": int(fps), "duration_s": round(float(duration_s), 3),
        "look": look, "narration": narration, "music": music, "music_volume": float(music_volume),
        "sfx": [{"src": str(c["src"]), "at_s": round(float(c["at_s"]), 3), "volume": float(c["volume"])} for c in sfx],
        "words": [{"text": w.text, "start_s": round(w.start_s, 3), "end_s": round(w.end_s, 3)} for w in words],
        "scenes": [s.to_dict() for s in scenes],
        "captions": bool(captions),
    }


def audio_seconds(path: Path) -> float:
    """The recording's length from ffprobe. Unreadable is a refusal, never 'some length'."""
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                             capture_output=True, text=True, timeout=60, check=True).stdout.strip()
    except (OSError, subprocess.SubprocessError) as e:
        raise ExplainerError(f"cannot read {path} with ffprobe ({type(e).__name__}): is it an audio file?") from None
    d = _num(out)
    if d is None or d <= 0:
        raise ExplainerError(f"{path} has no readable duration: is it an audio file?")
    return d


def render(props: dict, out_path: Path, *, files: Mapping[str, Path], engine_dir: Path = ENGINE_DIR,
           browser: Optional[str] = None, timeout_s: float = 1800, concurrency: int = 1,
           tmp_dir: Optional[Path] = None) -> Path:
    """Render the props with Remotion. ``files`` maps each public path the props name
    (narration, music, effects) to the file on disk; they are copied into a private
    public dir for this render only. Raises RenderFailed (RenderTimeout) with Remotion's last lines.

    ``tmp_dir``: where this render's scratch goes (the public dir, the props, and Remotion's own TMPDIR) instead of the
    system's. The creative worker's /tmp is a tmpfs, so a ten-minute render's audio and bundle there would count against the
    container's memory limit; it passes the job's own folder on the media volume."""
    if not (engine_dir / "node_modules").exists():
        raise ExplainerError(f"the Remotion engine is not installed: run `npm ci` in {engine_dir}")
    if shutil.which("npx") is None:
        raise ExplainerError("npx is not on PATH: install Node 22 to render")
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # A file left from an earlier run must not pass as this run's output.
    out_path.unlink(missing_ok=True)
    env = _render_env()
    if tmp_dir is not None:
        Path(tmp_dir).mkdir(parents=True, exist_ok=True)
        env["TMPDIR"] = str(Path(tmp_dir).resolve())
    with tempfile.TemporaryDirectory(prefix="explainer-", dir=str(tmp_dir) if tmp_dir is not None else None) as tmp:
        pub = (Path(tmp) / "public").resolve()
        pub.mkdir()
        for name, src in files.items():
            # The names become paths inside this render's public dir and nowhere else.
            dst = (pub / name).resolve() if name and not Path(name).is_absolute() else None
            if dst is None or ".." in Path(name).parts or not dst.is_relative_to(pub):
                raise ExplainerError(f"refusing the public file name {name!r}")
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
        props_file = Path(tmp) / "props.json"
        props_file.write_text(json.dumps(props), encoding="utf-8")
        cmd = ["npx", "remotion", "render", "src/index.ts", COMPOSITION, str(out_path.resolve()), f"--props={props_file}",
               f"--public-dir={pub}", f"--concurrency={int(concurrency)}", "--log=error"]
        if browser:
            cmd.append(f"--browser-executable={browser}")
        # Its own process group: on a timeout the whole tree goes (npx, node, the headless Chrome), not just npx, so
        # nothing keeps writing out_path after the caller was told the render failed.
        proc = subprocess.Popen(cmd, cwd=engine_dir, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                env=env, start_new_session=True)
        try:
            stdout, stderr = proc.communicate(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            _kill_group(proc)
            out_path.unlink(missing_ok=True)
            raise RenderTimeout(f"the render took longer than {timeout_s:.0f} s and was stopped") from None
        if proc.returncode != 0 or not out_path.exists() or out_path.stat().st_size == 0:
            tail = "\n".join((stderr or stdout or "").strip().splitlines()[-8:])
            raise RenderFailed(f"Remotion failed (exit {proc.returncode}): {tail}")
    return out_path


#: What the render needs from the environment; everything else (provider keys among it) stays out of it.
_RENDER_ENV_KEYS = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY",
                    "HTTP_PROXY", "NO_PROXY", "REMOTION_BROWSER_EXECUTABLE")


def _render_env() -> dict:
    return {k: v for k, v in os.environ.items() if k in _RENDER_ENV_KEYS}


def _kill_group(proc) -> None:
    import signal  # noqa: PLC0415

    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        pass
