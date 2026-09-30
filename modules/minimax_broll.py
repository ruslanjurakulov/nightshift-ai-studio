"""AI-generated b-roll with MiniMax H3 — the decision layer.

Why this exists
---------------
B-roll has always come from Pexels stock: real footage, but generic, and often
only loosely on-topic. MiniMax H3 is an omni-modal video model that generates a
short clip (4-15s, 768P/2K) from a text prompt, so a section about "the fall of
Constantinople" can get footage *of that*, not the nearest stock match. This
module is the part that decides **what to generate and how** — it is pure and
fully testable; the network call that actually renders a clip lives in
``modules/minimax_client.py`` and is off unless a key is configured.

The rules match the rest of the pipeline:

- **Additive and off by default.** Generated b-roll supplements Pexels; with the
  feature disabled nothing here runs and stock is used exactly as before.
- **Cost-aware, never greedy.** A generated clip is billable, so only a bounded
  number of a video's sections get one (``max_clips``) — the highest-value
  sections first (the hook, then the longest sections), the rest stay on stock.
- **Honest duration.** Each model family accepts its own clip lengths (H3
  4-15s, the v1 Hailuo models only 6 or 10s); a section's ask is fitted to the
  configured model rather than sending a request it will reject.
- **The prompt is the section's own subject**, built from its keywords and the
  video topic, and it explicitly asks for clean footage with no captions or
  watermarks (the pipeline burns its own subtitles later).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

#: MiniMax H3's supported clip-length window, in seconds — also the window used
#: for a model with no documented rule below.
MIN_CLIP_SECONDS = 4
MAX_CLIP_SECONDS = 15

_NEGATIVE = "no on-screen text, no captions, no subtitles, no watermark, no logo"

#: Clip lengths each model family accepts, matched on a lower-cased model-id
#: prefix (first match wins, so the longer prefix goes first). Either a
#: continuous ``(lo, hi)`` window or a fixed set of values. Sources are the
#: vendor SDKs and doc extracts recorded in the Scout reports of 2026-09-30.
#: A request outside these is rejected by the provider after the run has
#: already paid for everything before b-roll, so it is fixed here instead.
_DURATION_RULES = (
    ("minimax-h3-max", (5, 15), None),     # H3-Max: 5-15 s
    ("minimax-h3", (4, 15), None),         # H3: 4-15 s
    ("minimax-hailuo", None, (6, 10)),     # v1 Hailuo models: 6 or 10 s only (vendor MCP docstring)
    ("kling-", None, (5, 10)),             # the legacy text2video endpoint: "5" or "10"
    ("wan2.7", (2, 15), None),             # Wan 2.7: 2-15 s
    ("veo-3.1", None, (4, 6, 8)),          # Veo 3.1 family: 4, 6 or 8 s
)


def duration_rule(model: Optional[str]):
    """``(window, allowed_values)`` for ``model``; exactly one of them is set.
    An unknown model keeps the historical 4-15 s window."""
    m = (model or "").strip().lower()
    for prefix, window, allowed in _DURATION_RULES:
        if m.startswith(prefix):
            return window, allowed
    return (MIN_CLIP_SECONDS, MAX_CLIP_SECONDS), None


def clamp_duration(seconds, model: Optional[str] = None) -> int:
    """Fit a requested clip length to what ``model`` accepts: clamped into a
    continuous window, or snapped to the nearest allowed value (the shorter,
    cheaper one on a tie). Non-numeric or non-positive requests fall back to
    the shortest allowed length rather than raising."""
    window, allowed = duration_rule(model)
    try:
        s = float(seconds)
        if s <= 0:
            raise ValueError
    except (TypeError, ValueError):
        return min(allowed) if allowed else window[0]
    if allowed:
        return min(sorted(allowed), key=lambda v: abs(v - s))
    return max(window[0], min(window[1], int(round(s))))


class VideoModelUnavailable(RuntimeError):
    """The configured video model could not produce the clips this run asked
    for, and nothing else will be substituted for them.

    CLAUDE.md #4: a channel set to generated b-roll must not quietly go out on
    stock footage, or on a different model than the one configured. The run
    stops, and the message names the remedy rather than the symptom. The
    message never carries a key or any part of one."""

    def __init__(self, provider: str, model: str, reason: str, remedy: str):
        self.provider = provider
        self.model = model
        self.reason = reason
        self.remedy = remedy
        super().__init__(f"{provider} ({model or 'no model'}): {reason}. Fix: {remedy}")


# Why a provider said no → what the operator does about it. "auth" and "quota"
# often share an HTTP status and need opposite fixes (CLAUDE.md #6), so a
# vendor's own error code, when it has one, picks the category first.
AUTH, QUOTA, RATE, NOT_FOUND, INVALID, POLICY, UNAVAILABLE = (
    "auth", "quota", "rate_limited", "not_found", "invalid_request", "policy", "unavailable")


def category_for_status(status: Optional[int]) -> str:
    if status in (401, 403):
        return AUTH
    if status == 402:
        return QUOTA
    if status == 429:
        return RATE
    if status == 404:
        return NOT_FOUND
    if status is not None and 400 <= status < 500:
        return INVALID
    return UNAVAILABLE


def _clean(text, secrets=()) -> str:
    """A vendor message, safe to put in a log line: one line, bounded, and with
    any credential the caller holds cut out — some APIs echo the key they
    were sent back in their error text."""
    out = " ".join(str(text or "").split())
    for secret in secrets:
        if secret:
            out = out.replace(secret, "[redacted]")
    return out[:200]


def rejection(provider: str, model: str, *, status: Optional[int] = None,
              category: Optional[str] = None, code="", message="",
              key_hint: str = "the API key", secrets=()) -> VideoModelUnavailable:
    """The ``VideoModelUnavailable`` for a provider refusing (or not answering)
    a generation request, with the remedy for its category.

    A credentials refusal drops the vendor's message text: that is the message
    most likely to quote the key back (in full or masked), and no part of a
    key may reach a log. The vendor's code is kept."""
    category = category or category_for_status(status)
    message = "" if category == AUTH else _clean(message, secrets)
    detail = ", ".join(x for x in (
        f"HTTP {status}" if status else "", _clean(code, secrets), message) if x)
    what = {
        AUTH: "refused the credentials",
        QUOTA: "refused the request for quota or billing",
        RATE: "rate-limited the request",
        NOT_FOUND: "does not know this model or endpoint",
        INVALID: "rejected the request as invalid",
        POLICY: "refused the prompt under its content policy",
        UNAVAILABLE: "did not answer",
    }[category]
    remedy = {
        AUTH: f"check {key_hint}; a key issued for one region or console is refused by another",
        QUOTA: f"top up the {provider} account, or lower CHRONOS_MINIMAX_BROLL_MAX_CLIPS, then re-run",
        RATE: "wait and re-run; clips already made are reused from the task ledger, not paid for again",
        NOT_FOUND: f"check the model id {model!r} and the endpoint settings against the {provider} docs",
        INVALID: f"check the model id {model!r} and its settings; retrying the same request will not help",
        POLICY: "reword the section keywords that fed this prompt, then re-run",
        UNAVAILABLE: "re-run; a clip that was never submitted was never charged, and submitted "
                     "ones are polled from the task ledger instead of paid for again",
    }[category]
    return VideoModelUnavailable(provider, model, what + (f" ({detail})" if detail else ""), remedy)


@dataclass(frozen=True)
class GenerationSpec:
    """One clip to generate: a fully-built prompt, its length, and the section
    it belongs to (so the compositor can place it and record its keyword)."""

    prompt: str
    duration_seconds: int
    section_index: int
    keyword: str = ""
    negative_prompt: str = _NEGATIVE

    def to_dict(self) -> dict:
        return {
            "prompt": self.prompt,
            "duration_seconds": self.duration_seconds,
            "section_index": self.section_index,
            "keyword": self.keyword,
            "negative_prompt": self.negative_prompt,
        }


def build_prompt(topic: str, keywords: List[str], *, style: str = "cinematic, documentary, realistic") -> str:
    """A text-to-video prompt for one section: its concrete subject first, the
    video's topic for context, then a consistent visual style. Empty/blank
    keywords fall back to the topic so a prompt is always non-empty."""
    terms = [k.strip() for k in (keywords or []) if k and k.strip()]
    subject = ", ".join(dict.fromkeys(terms)) if terms else (topic or "").strip()
    topic_clause = f" — {topic.strip()}" if topic and topic.strip() and subject != topic.strip() else ""
    subject = subject or "an evocative establishing shot"
    return f"{subject}{topic_clause}. {style}. {_NEGATIVE}."


def _field(section, key):
    """Read `key` from a section that may be a dict or an object (e.g. the
    script's Section dataclass), so this module works with either."""
    if isinstance(section, dict):
        return section.get(key)
    return getattr(section, key, None)


def _section_len(section) -> float:
    for key in ("duration", "duration_seconds", "length", "seconds"):
        v = _field(section, key)
        try:
            if v is not None and float(v) > 0:
                return float(v)
        except (TypeError, ValueError):
            continue
    return float(MIN_CLIP_SECONDS)


def _section_keywords(section) -> List[str]:
    kws = _field(section, "keywords")
    if isinstance(kws, (list, tuple)):
        return [str(k) for k in kws]
    if isinstance(kws, str) and kws.strip():
        return [kws.strip()]
    return []


def select_specs(sections: list, topic: str, *, max_clips: int, style_for=None,
                 model: Optional[str] = None) -> List[GenerationSpec]:
    """Choose which sections get a generated clip and build a spec for each.

    Only sections that carry at least one keyword are eligible (a section we
    can't describe, we don't try to generate). Among those, the hook (index 0,
    if eligible) is always kept, then the longest sections, up to ``max_clips``.
    Returns [] when the feature would generate nothing (no eligible sections, or
    a non-positive budget) — the caller then falls back to stock entirely.

    ``style_for`` (optional) is ``index -> style string``: when given, each
    clip's prompt carries that scene's style direction instead of the default.
    That string may combine Director Mode's shot direction (camera/lens/
    lighting/motion, modules/director.py) with a Character-Bible consistency
    directive (modules/elements.py).
    None keeps the default look, so an unconfigured run is unchanged.

    ``model`` is the model the clips will be sent to; each clip's length is
    fitted to what that model accepts (``clamp_duration``)."""
    if max_clips <= 0:
        return []

    eligible = []
    for i, section in enumerate(sections or []):
        if section is None:
            continue
        kws = _section_keywords(section)
        if not kws:
            continue
        eligible.append((i, section, kws))
    if not eligible:
        return []

    # Rank: the hook first (a strong opening clip earns its cost), then by
    # length descending (a longer section benefits more from bespoke footage).
    def rank_key(item):
        i, section, _ = item
        return (0 if i == 0 else 1, -_section_len(section), i)

    chosen = sorted(eligible, key=rank_key)[:max_clips]
    # Emit in section order so the timeline stays natural.
    chosen.sort(key=lambda item: item[0])

    specs: List[GenerationSpec] = []
    for i, section, kws in chosen:
        style = None
        if style_for is not None:
            try:
                style = style_for(i) or None
            except Exception:
                style = None
        prompt = build_prompt(topic, kws, style=style) if style else build_prompt(topic, kws)
        specs.append(GenerationSpec(
            prompt=prompt,
            duration_seconds=clamp_duration(_section_len(section), model),
            section_index=i,
            keyword=kws[0],
        ))
    return specs


@dataclass(frozen=True)
class GenerationResult:
    """What actually got generated, for the advisory event. `paths` are the
    clips produced (by section index); `attempted`/`generated` are honest counts
    so a run that asked for 2 and got 1 reads as such, never as success."""

    attempted: int = 0
    generated: int = 0
    model: str = ""
    by_section: dict = field(default_factory=dict)   # section_index -> path
    #: Clips taken from this run's earlier attempt (already downloaded, found
    #: in the provider task ledger) — produced with no new request, so no new
    #: charge. Always <= generated.
    reused: int = 0
    #: section_index -> provider task id, for clips that came from a tracked
    #: task (modules/provider_tasks.py). Lets the Video IR tie an asset back to
    #: the paid job that made it.
    task_ids: dict = field(default_factory=dict)

    @property
    def newly_generated(self) -> int:
        """Clips this attempt actually paid a provider for (generated minus
        reused) — the honest number for the cost ledger."""
        return max(0, self.generated - self.reused)

    def to_dict(self) -> dict:
        out = {
            "attempted": self.attempted,
            "generated": self.generated,
            "model": self.model,
            "sections": sorted(self.by_section.keys()),
        }
        if self.reused:
            out["reused"] = self.reused
        if self.task_ids:
            out["task_ids"] = {f"s{int(i):03d}": t for i, t in sorted(self.task_ids.items())}
        return out


def summarize(result: GenerationResult) -> dict:
    """Metadata for a single ``broll.generated`` event."""
    return result.to_dict()
