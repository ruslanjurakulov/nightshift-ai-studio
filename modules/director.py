"""Director Mode — a cinematic shot plan for each scene (Nightshift blueprint).

Higgsfield's insight, made concrete: a video model does far better with a
*shot* description — camera move, lens, lighting, mood, motion — than with a
bare "cinematic" tag. This module turns a script's sections into that shot
plan, deterministically and with no external API, so:

  * the b-roll generation prompt for a section carries its shot direction
    (see `cinematic_style` + `modules/minimax_broll.build_prompt`), and
  * the Command Center can show the plan as one advisory `director.plan` event.

It is pure and fully unit-tested. It never gates a run and never edits the
script; an empty/blank section list yields an empty plan. The channel's own
visual style flows in, so two channels get different looks from the same
structure.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

# Words in a section's narration/name that mark the emotional beat, so the plan
# escalates on a reveal and resolves at the close rather than being uniform.
_REVEAL_CUES = ("reveal", "secret", "truth", "finally", "discover", "hidden", "shock", "twist")
_CLOSE_CUES = ("subscribe", "next time", "in the end", "conclusion", "thanks for", "outro")


@dataclass(frozen=True)
class ShotPlan:
    """One scene's cinematic direction. All strings, all human-readable — this
    is a plan a person could hand a cinematographer, and a prompt a video model
    can act on."""
    section_index: int
    name: str
    shot_type: str
    camera_move: str
    lens: str
    lighting: str
    mood: str
    motion: str


def _text(section) -> str:
    if isinstance(section, dict):
        return f"{section.get('name', '')} {section.get('narration', '')}".lower()
    return f"{getattr(section, 'name', '')} {getattr(section, 'narration', '')}".lower()


def _section_type(section) -> str:
    if isinstance(section, dict):
        return str(section.get("type") or section.get("section_type") or "story").lower()
    return str(getattr(section, "section_type", "story") or "story").lower()


def _beat(section, index: int, total: int) -> str:
    """Which narrative beat this section is: hook, reveal, close, or body."""
    if index == 0 or _section_type(section) == "hook":
        return "hook"
    text = _text(section)
    if any(cue in text for cue in _CLOSE_CUES) or (total > 1 and index == total - 1):
        return "close"
    if any(cue in text for cue in _REVEAL_CUES):
        return "reveal"
    return "body"


def _style_terms(visual_style: str) -> tuple:
    """Derive (lighting, mood) flavour from the channel's visual style string,
    falling back to a neutral cinematic look when none is set — never empty."""
    s = (visual_style or "").strip().lower()
    if not s:
        return ("cinematic key light", "cinematic")
    return (f"{s} lighting", s)


def plan_shot(section, index: int, total: int, visual_style: str = "") -> ShotPlan:
    """The shot plan for one section, from its beat and the channel style."""
    beat = _beat(section, index, total)
    style_light, style_mood = _style_terms(visual_style)
    name = (section.get("name") if isinstance(section, dict) else getattr(section, "name", "")) or f"scene {index + 1}"

    if beat == "hook":
        return ShotPlan(index, name, "reveal opening", "slow push-in",
                        "wide anamorphic", f"low-key, {style_light}",
                        f"tense, {style_mood}", "slow, deliberate")
    if beat == "reveal":
        return ShotPlan(index, name, "dramatic reveal", "crash zoom then crane up",
                        "wide", f"high-contrast, {style_light}",
                        f"climactic, {style_mood}", "accelerating")
    if beat == "close":
        return ShotPlan(index, name, "resolution", "slow pull-back",
                        "wide establishing", f"soft, {style_light}",
                        f"resolved, {style_mood}", "settling")
    # body — alternate establishing vs detail so a long middle never flatlines
    if index % 2 == 0:
        return ShotPlan(index, name, "establishing", "gentle dolly",
                        "standard", style_light, style_mood, "steady drift")
    return ShotPlan(index, name, "detail", "slow orbit",
                    "medium close", style_light, style_mood, "subtle handheld")


def plan_video(sections: list, visual_style: str = "") -> List[ShotPlan]:
    """A shot plan for each section, in order. [] for no sections."""
    items = [s for s in (sections or []) if s is not None]
    total = len(items)
    return [plan_shot(s, i, total, visual_style) for i, s in enumerate(items)]


def cinematic_style(plan: ShotPlan) -> str:
    """A style suffix for a b-roll prompt (modules/minimax_broll.build_prompt) —
    the shot's direction as comma-separated cinematic terms."""
    return ", ".join([plan.shot_type, plan.camera_move, plan.lens, plan.lighting, plan.motion])


def style_map(plans: List[ShotPlan]) -> dict:
    """{section_index: cinematic_style} — what the b-roll generator consults to
    give each generated clip its own shot direction."""
    return {p.section_index: cinematic_style(p) for p in plans}


def summarize(plans: List[ShotPlan], limit: int = 8) -> dict:
    """Metadata for one `director.plan` advisory event."""
    return {
        "scenes": len(plans),
        "shots": [
            {"scene": p.section_index + 1, "name": p.name, "shot": p.shot_type,
             "camera": p.camera_move, "mood": p.mood}
            for p in plans[:limit]
        ],
    }
