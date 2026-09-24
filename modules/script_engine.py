"""Stage 2: Gemini Script Engine — 3-sec Hook + Open Loops + Pauses + Multi-Voice + SFX Cues."""

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from google.genai import types as genai_types

from config import GEMINI_MODEL, SCRIPT_LANGUAGE, VIDEO_DURATION_TARGET
from modules.gemini_client import generate_with_retry, make_client
from modules.performance_analyzer import PerformanceAnalyzer
from modules.research_engine import ResearchBrief

logger = logging.getLogger(__name__)

SCRIPT_SYSTEM_PROMPT = """
You are an elite viral YouTube scriptwriter. Your scripts follow strict retention psychology rules:

HOOK RULE: Never start from the beginning. Start from the CLIMAX — the most shocking/mysterious moment.
Example bad hook: "In the 18th century, there was an event..."
Example GREAT hook: "They found Europe's biggest treasure — and within 5 minutes, it sank forever..."

OPEN LOOPS: Plant 2-3 questions that you answer only at the end. Example:
"But who hid the treasure? We'll get to that at the very end..."

PAUSES: Mark dramatic pauses with [PAUSE:1.5] (number = seconds of silence). Use after shocking reveals.

MULTI-VOICE: Main narrator uses [VOICE:main]. For quotes, mysterious facts, or character speech use [VOICE:secondary].
Example: [VOICE:secondary] "I will never reveal the secret," he whispered.

SFX CUES: Inline [SFX:sound_name] — available sounds:
  whoosh, deep_boom, paper_turn, dramatic_sting, thunder_crack, heartbeat,
  clock_tick, suspense_riser, glass_shatter, choir_hit, eerie_wind, fire_crackle

MUSIC CUES: [MUSIC:intro_high] at start, [MUSIC:story_low] during narrative, [MUSIC:climax_high] at peak moments.

STRUCTURE RULE: The script MUST have exactly 2 top-level parts:
  PART 1 — "hook" section (type: "hook", duration 0-15 seconds): Start from the CLIMAX.
    Shock the viewer. No context yet. Make them desperately want to know what happened.
  PART 2 — "main_story" sections (type: "story"): Chronological, detailed narrative.
    Each section ~45-60 seconds. This is where you answer the open loops.

Return a JSON object with this EXACT schema:
{
  "title": "YouTube title — start with number or power word, max 80 chars",
  "title_ab": "Alternative A/B test title",
  "hook_ab": "An ALTERNATE opening for the first section — a different first 15-30s hook (a different angle/emotion) that still pays off the same title. Full narration text with [PAUSE]/[SFX]/[MUSIC] cues, like a section's narration. Used to A/B-test the opening on retention.",
  "description": "YouTube description: 3 paragraphs + timestamps + hashtags",
  "tags": ["tag1", "tag2"],
  "hook_sentence": "The 3-second hook sentence (from the climax)",
  "thumbnail_prompt_a": "Thumbnail A: dramatic scene, person with shocked expression, dark cinematic",
  "thumbnail_prompt_b": "Thumbnail B: different angle/color, text overlay idea",
  "thumbnail_overlay_text": "Short shock text for thumbnail (max 4 words, e.g. NEVER OPENED!)",
  "open_loops": ["loop question 1", "loop question 2"],
  "sections": [
    {
      "name": "hook",
      "type": "hook",
      "voice": "main",
      "narration": "[MUSIC:intro_high] [SFX:dramatic_sting] They found Europe's biggest treasure... [PAUSE:1.5] and within 5 minutes, [SFX:deep_boom] it sank forever. [PAUSE:1.0] But HOW? [PAUSE:0.5] And who is responsible?",
      "duration_hint": 15,
      "cut_interval": 2,
      "keywords": ["sunken treasure ship", "stormy ocean night"]
    },
    {
      "name": "open_loop_plant",
      "type": "story",
      "voice": "main",
      "narration": "[MUSIC:story_low] Let me take you back to 1715... [PAUSE:1.0] But first — who was the man behind all of this? We'll reveal that at the very end.",
      "duration_hint": 20,
      "cut_interval": 5,
      "keywords": ["old sailing ship", "antique map candlelight"]
    }
  ]
}

KEYWORDS RULE: Every section MUST include 2-3 "keywords" — literal, filmable
stock-footage search terms for Pexels that match that section's mood. Describe
what the CAMERA SEES, not the idea: "storm waves lighthouse" not "mystery".
Avoid proper nouns and dates — stock libraries have no footage of them.
"""


@dataclass
class ScriptSection:
    name: str
    narration: str
    duration_hint: int
    voice: str = "main"
    section_type: str = "story"   # "hook" | "story"
    cut_interval: float = 5.0     # seconds between video cuts (2s for hook, 5s for story)
    keywords: list[str] = field(default_factory=list)  # Pexels search terms
    sfx_cues: list[dict] = field(default_factory=list)
    music_cues: list[dict] = field(default_factory=list)
    pauses: list[dict] = field(default_factory=list)

    def clean_narration(self) -> str:
        """Strip all cue tags, return plain TTS-ready text."""
        text = self.narration
        text = re.sub(r"\[SFX:[^\]]+\]", "", text)
        text = re.sub(r"\[MUSIC:[^\]]+\]", "", text)
        text = re.sub(r"\[PAUSE:[^\]]+\]", "", text)
        text = re.sub(r"\[VOICE:[^\]]+\]", "", text)
        return re.sub(r" {2,}", " ", text).strip()

    def tts_segments(self) -> list[dict]:
        """Split narration by [VOICE:X] tags into segments with voice labels."""
        segments = []
        pattern = r"(\[VOICE:(\w+)\])"
        parts = re.split(pattern, self.narration)
        current_voice = self.voice
        buffer = ""
        i = 0
        while i < len(parts):
            part = parts[i]
            if re.match(r"\[VOICE:\w+\]", part):
                if buffer.strip():
                    segments.append({"voice": current_voice, "text": _strip_cues(buffer)})
                    buffer = ""
                current_voice = parts[i + 1] if i + 1 < len(parts) else current_voice
                i += 2
            else:
                buffer += part
                i += 1
        if buffer.strip():
            segments.append({"voice": current_voice, "text": _strip_cues(buffer)})
        return segments

    def tts_timeline(self) -> list[dict]:
        """Speech and silence events in written order.

        tts_segments() splits on [VOICE:] only, which loses where each [PAUSE:n]
        sat — the mixer could then do nothing better than pile every pause at the
        end of the section. This keeps them in place, so a pause after a reveal
        lands after that reveal.

        Events are {"kind": "speech", "voice": str, "text": str}
                or {"kind": "pause", "duration": float}.
        """
        events: list[dict] = []
        voice = self.voice
        buffer = ""
        pos = 0

        def flush():
            nonlocal buffer
            text = _strip_cues(buffer)
            if text:
                events.append({"kind": "speech", "voice": voice, "text": text})
            buffer = ""

        marker = re.compile(r"\[VOICE:(\w+)\]|\[PAUSE:([\d.]+)\]")
        for m in marker.finditer(self.narration):
            buffer += self.narration[pos:m.start()]
            pos = m.end()
            flush()
            if m.group(1) is not None:
                voice = m.group(1)
            else:
                events.append({"kind": "pause", "duration": float(m.group(2))})

        buffer += self.narration[pos:]
        flush()
        return events

    def extract_pauses(self) -> list[dict]:
        pauses = []
        for m in re.finditer(r"\[PAUSE:([\d.]+)\]", self.narration):
            pauses.append({"duration": float(m.group(1)), "char_pos": m.start()})
        return pauses

    def extract_sfx(self) -> list[dict]:
        return [
            {"name": m.group(1).strip(), "char_pos": m.start()}
            for m in re.finditer(r"\[SFX:([^\]]+)\]", self.narration)
        ]

    def extract_music(self) -> list[dict]:
        return [
            {"cue": m.group(1).strip(), "char_pos": m.start()}
            for m in re.finditer(r"\[MUSIC:([^\]]+)\]", self.narration)
        ]


def _strip_cues(text: str) -> str:
    text = re.sub(r"\[SFX:[^\]]+\]", "", text)
    text = re.sub(r"\[MUSIC:[^\]]+\]", "", text)
    text = re.sub(r"\[PAUSE:[^\]]+\]", "", text)
    text = re.sub(r"\[VOICE:[^\]]+\]", "", text)
    return re.sub(r" {2,}", " ", text).strip()


@dataclass
class Script:
    topic: str
    title: str
    title_ab: str
    description: str
    tags: list[str]
    hook_sentence: str
    sections: list[ScriptSection]
    thumbnail_prompt_a: str
    thumbnail_prompt_b: str
    thumbnail_overlay_text: str
    open_loops: list[str]
    #: An alternate opening for the first section, for the first-30-seconds hook
    #: A/B (roadmap #60). Empty when the model didn't provide one — the hook
    #: experiment then simply has no B arm for this video (never a fabricated
    #: opening). See main.py, which swaps it in only for the "B" hook arm.
    hook_ab: str = ""

    def full_narration(self) -> str:
        return "\n\n".join(s.clean_narration() for s in self.sections)

    def all_sfx_cues(self) -> list[dict]:
        return [cue for s in self.sections for cue in s.extract_sfx()]

    def all_music_cues(self) -> list[dict]:
        return [cue for s in self.sections for cue in s.extract_music()]

    def scene_plan(self) -> list[dict]:
        """The structured scene plan for the Command Center's Storyboard
        (migration 0011): one entry per section with its type, its CUE-STRIPPED
        narration and the b-roll keywords that drove its footage. Distinct from
        ``to_dict``: the narration is the clean, readable text (no ``[SFX]`` /
        ``[MUSIC]`` markers), and only the fields the Storyboard shows are kept.
        """
        return [
            {
                "name": s.name,
                "type": s.section_type,
                "narration": s.clean_narration(),
                "duration_hint": s.duration_hint,
                "keywords": list(s.keywords),
            }
            for s in self.sections
        ]

    def to_dict(self) -> dict:
        """Serialize back to the same JSON shape ScriptEngine._parse consumes."""
        return {
            "topic": self.topic,
            "title": self.title,
            "title_ab": self.title_ab,
            "hook_ab": self.hook_ab,
            "description": self.description,
            "tags": self.tags,
            "hook_sentence": self.hook_sentence,
            "thumbnail_prompt_a": self.thumbnail_prompt_a,
            "thumbnail_prompt_b": self.thumbnail_prompt_b,
            "thumbnail_overlay_text": self.thumbnail_overlay_text,
            "open_loops": self.open_loops,
            "sections": [
                {
                    "name": s.name,
                    "type": s.section_type,
                    "voice": s.voice,
                    "narration": s.narration,
                    "duration_hint": s.duration_hint,
                    "cut_interval": s.cut_interval,
                    "keywords": s.keywords,
                }
                for s in self.sections
            ],
        }

    def save(self, path: Path) -> Path:
        """Write to disk so a re-run can skip the paid generation step."""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2, ensure_ascii=False),
                        encoding="utf-8")
        return path


def _format_research_notes(research_brief: "ResearchBrief | None") -> str:
    """Render a ResearchBrief into an appendable prompt section.

    Returns "" when no brief was supplied (the default, backward-compatible
    path). When a brief IS supplied, this deliberately does NOT tell Gemini
    the facts are verified — research_engine.py's own output is unverified
    LLM recall self-rated by confidence, and that honesty framing has to
    carry through here too, so the script generator treats these as
    inspiration to build a narrative from and not as ground truth to narrate
    confidently.
    """
    if research_brief is None:
        return ""

    lines = [
        "\n\nResearch notes (unverified, use as inspiration — verify anything "
        "presented as fact in the final script):",
    ]

    if research_brief.key_facts:
        for fact in research_brief.key_facts:
            line = f"- [{fact.confidence}] {fact.claim}"
            if fact.caveat:
                line += f" (caveat: {fact.caveat})"
            lines.append(line)
    else:
        lines.append("- (no key facts recalled)")

    if research_brief.open_questions:
        lines.append("Open questions (unresolved, do not assert as fact):")
        for question in research_brief.open_questions:
            lines.append(f"- {question}")

    if research_brief.suggested_angle:
        lines.append(f"Suggested editorial angle: {research_brief.suggested_angle}")

    return "\n".join(lines)


class ScriptEngine:
    """Writes one script.

    An optional ``channel`` supplies that channel's language, target duration
    and strategy text. Without one, every value comes from ``config.py`` exactly
    as before, so a single-channel deployment generates identical prompts.
    """

    def __init__(self, channel=None):
        self.channel = channel
        self.client = make_client()
        self.performance_analyzer = self._safe_make_performance_analyzer(channel)
        self.retention_analyzer = self._safe_make_retention_analyzer(channel)
        # The most recent Gemini response, so the caller can record what the
        # generation actually cost. None until generate() runs.
        self.last_response = None

    def _safe_make_performance_analyzer(self, channel=None) -> "PerformanceAnalyzer | None":
        """PerformanceAnalyzer's own methods already degrade to "" on any
        internal failure, but constructing it (which opens a StateStore) is
        not covered by that guarantee — a failure here must never stop a
        script from being written.
        """
        try:
            # A channel's writer sees only that channel's own past performance:
            # Finance's numbers must not shape a History script.
            channel_id = str(channel.channel_id) if channel is not None else None
            return PerformanceAnalyzer(channel_id=channel_id)
        except Exception as e:
            logger.warning(
                "Failed to construct PerformanceAnalyzer (%s: %s) — writing the "
                "script without past-performance context",
                type(e).__name__, e,
            )
            return None

    def _safe_make_retention_analyzer(self, channel=None):
        """Same guarantee as the performance analyzer: its reads already degrade
        to "" on failure, but constructing it opens a StateStore, and that must
        not stop a script being written."""
        try:
            from modules.retention_analyzer import RetentionAnalyzer

            channel_id = str(channel.channel_id) if channel is not None else None
            return RetentionAnalyzer(channel_id=channel_id)
        except Exception as e:
            logger.warning(
                "Failed to construct RetentionAnalyzer (%s: %s) — writing the script "
                "without retention context",
                type(e).__name__, e,
            )
            return None

    def _retention_context(self) -> str:
        """Where this channel's viewers actually stop watching.

        The strongest signal a writer can act on, and the one the feedback loop
        cannot give: topic scores say *what* to make, retention says *how* the
        last one lost people. Returns "" below the evidence floor.
        """
        if self.retention_analyzer is None:
            return ""
        try:
            return self.retention_analyzer.as_prompt_text()
        except Exception as e:
            logger.warning(
                "RetentionAnalyzer.as_prompt_text failed (%s: %s) — writing the script "
                "without retention context",
                type(e).__name__, e,
            )
            return ""

    def _learning_context(self) -> str:
        """Learnings a human APPROVED for this channel (modules/learning_memory.py).

        The analyzers above feed the writer automatically; this block is the
        opposite kind of signal — only what an operator signed off on. Pending
        and rejected proposals never reach it, and with nothing approved it is
        "", so the prompt is exactly what it was before learning memory existed.
        """
        try:
            from modules import learning_memory

            channel_id = str(self.channel.channel_id) if self.channel is not None else "default"
            return learning_memory.approved_learnings_as_prompt_text(
                channel_id, learning_memory.SCRIPT_PROMPT_KINDS
            )
        except Exception as e:
            logger.warning(
                "Approved learnings unavailable (%s: %s) — writing the script without them",
                type(e).__name__, e,
            )
            return ""

    def _performance_context(self) -> str:
        """Real past-performance numbers for this channel's own videos,
        rendered as optional context to append to the script prompt.

        This is the same feedback-loop idea as topic_manager.py's use of the
        analyzer, but here it tells the *writer* which of this channel's own
        past topics actually resonated — ambient context to gauge tone and
        framing against, never a template to copy (analyze_videos_as_prompt_text
        frames it that way itself, and returns "" below two videos with
        metrics, so there is no empty section on a fresh channel).
        """
        if self.performance_analyzer is None:
            return ""
        try:
            return self.performance_analyzer.analyze_videos_as_prompt_text()
        except Exception as e:
            logger.warning(
                "PerformanceAnalyzer.analyze_videos_as_prompt_text failed (%s: %s) — "
                "writing the script without past-performance context",
                type(e).__name__, e,
            )
            return ""

    @staticmethod
    def load(path: Path, topic: str | None = None) -> Script:
        """Rebuild a Script from a saved JSON file — no API call, no quota spent.

        Lets stages 3-7 be exercised without paying for generation again, which
        matters when a later stage crashes or the daily quota is gone.
        """
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return ScriptEngine._parse(topic or data.get("topic", "untitled"), data)

    def _gen(self, prompt: str, system: str | None = None) -> str:
        config = genai_types.GenerateContentConfig(
            system_instruction=system,
        ) if system else None
        response = generate_with_retry(self.client, GEMINI_MODEL, prompt, config)
        self.last_response = response
        return response.text

    def generate(
        self,
        topic: str,
        research_brief: "ResearchBrief | None" = None,
        working_title: str | None = None,
        strategy_note: str = "",
    ) -> Script:
        """Generate a script for `topic`.

        `working_title`, when given, is a title decided BEFORE this call (see
        modules/title_planner.py): the script is written to deliver on that exact
        promise, and the produced Script's `title` is set to it so the video
        ships under the title it was planned for. None keeps today's behaviour —
        the title comes from the model.

        `strategy_note`, when given, is a channel-lifecycle guidance paragraph
        (see modules/strategy.py) appended to the prompt — launch channels are
        written for broad appeal, established ones for depth. "" keeps the prompt
        exactly as before."""
        prompt = self._build_prompt(topic, research_brief, channel=self.channel,
                                    working_title=working_title, strategy_note=strategy_note)
        performance_context = self._performance_context()
        if performance_context:
            prompt += f"\n\n{performance_context}"
        retention_context = self._retention_context()
        if retention_context:
            prompt += f"\n\n{retention_context}"
        learning_context = self._learning_context()
        if learning_context:
            prompt += f"\n\n{learning_context}"
        logger.info("Generating script for: %s", topic)
        text = self._gen(prompt, system=SCRIPT_SYSTEM_PROMPT)
        raw = self._extract_json(text)
        script = self._parse(topic, raw)
        # The planned title is the decision; the script delivers it. Overriding
        # here guarantees the video ships under the title it was made for, even
        # if the model echoed a slightly different one. The model's own title
        # becomes the A/B alternative when it didn't already supply one.
        if working_title:
            planned = working_title.strip()
            if planned:
                if not script.title_ab and script.title and script.title.strip() != planned:
                    script.title_ab = script.title
                script.title = planned
        return script

    @staticmethod
    def _build_prompt(
        topic: str, research_brief: "ResearchBrief | None" = None, channel=None,
        working_title: str | None = None, strategy_note: str = "",
    ) -> str:
        """Assemble the user-side prompt.

        A channel contributes its language, duration and strategy text. The
        channel's own instructions are APPENDED to the shared retention rules in
        SCRIPT_SYSTEM_PROMPT rather than replacing them — hook, open loops and
        cue structure are what makes a Nightshift video a Nightshift video, on every
        channel. Its visual style is included because the section `keywords`
        this prompt asks for are what the stock-footage search runs on, so the
        style has to reach the writer to reach the screen.
        """
        agent = channel.agent if channel is not None else None
        language = agent.language if agent else SCRIPT_LANGUAGE
        duration = agent.target_duration_seconds if agent else VIDEO_DURATION_TARGET

        prompt = (
            f"Topic: {topic}\n"
            f"Language: {language}\n"
            f"Target duration: {duration} seconds\n\n"
        )
        if channel is not None:
            prompt += f"Channel: {channel.name}\n"
            if channel.niche:
                prompt += f"Channel niche: {channel.niche}\n"
            if agent.system_prompt:
                prompt += f"\nChannel content strategy:\n{agent.system_prompt}\n"
            if agent.niche_rules:
                prompt += f"\nChannel rules (follow these):\n{agent.niche_rules}\n"
            if agent.visual_style_prompt:
                prompt += (
                    "\nChannel visual style — every section's `keywords` must describe "
                    f"footage in this style:\n{agent.visual_style_prompt}\n"
                )
            prompt += "\n"

        # Channel-lifecycle strategy note (modules/strategy.py). Appended, never
        # a replacement — empty keeps the prompt exactly as it was.
        if strategy_note:
            prompt += f"\n{strategy_note}\n"

        if working_title:
            prompt += (
                "\nPre-decided title — this video is being MADE to deliver this exact promise:\n"
                f'"{working_title}"\n'
                "Use this as the JSON `title`. Write the hook and open loops to pay it off "
                "directly; do not drift to a different angle or over-promise beyond what the "
                "script can honestly deliver.\n\n"
            )

        prompt += (
            "Write the full viral YouTube script JSON now. "
            "Include at least 6 sections, 2 open loops, and multiple [PAUSE], [SFX], [MUSIC] cues."
        )
        prompt += _format_research_notes(research_brief)
        return prompt

    def _extract_json(self, text: str) -> dict:
        text = re.sub(r"^```(?:json)?\s*", "", text.strip(), flags=re.MULTILINE)
        text = re.sub(r"\s*```$", "", text.strip(), flags=re.MULTILINE)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            match = re.search(r"\{[\s\S]+\}", text)
            if match:
                return json.loads(match.group())
            raise ValueError("Gemini did not return valid JSON") from None

    @staticmethod
    def extract_visual_keywords(script: "Script") -> list[dict]:
        """Per-section Pexels search keywords.

        These come back inside the script JSON itself (see KEYWORDS RULE in the
        system prompt), so this costs no extra API call — it used to be a second
        round-trip, which mattered on the free tier's 20 requests/day.
        Sections where Gemini omitted keywords fall back to the topic words.
        """
        fallback = [w for w in script.topic.lower().split() if len(w) > 3][:2]
        return [
            {"section": s.name, "keywords": s.keywords or fallback}
            for s in script.sections
        ]

    @staticmethod
    def _parse(topic: str, data: dict) -> Script:
        sections = []
        for i, s in enumerate(data.get("sections", [])):
            sec = ScriptSection(
                name=s.get("name", f"section_{i}"),
                narration=s.get("narration", ""),
                duration_hint=int(s.get("duration_hint", 45)),
                voice=s.get("voice", "main"),
                section_type=s.get("type", "hook" if i == 0 else "story"),
                cut_interval=float(s.get("cut_interval", 2.0 if i == 0 else 5.0)),
                keywords=[str(k).strip() for k in (s.get("keywords") or []) if str(k).strip()],
            )
            sec.sfx_cues = sec.extract_sfx()
            sec.music_cues = sec.extract_music()
            sec.pauses = sec.extract_pauses()
            sections.append(sec)

        return Script(
            topic=topic,
            title=data.get("title", topic),
            title_ab=data.get("title_ab", ""),
            description=data.get("description", ""),
            tags=data.get("tags", []),
            hook_sentence=data.get("hook_sentence", data.get("hook", "")),
            sections=sections,
            thumbnail_prompt_a=data.get("thumbnail_prompt_a", ""),
            thumbnail_prompt_b=data.get("thumbnail_prompt_b", ""),
            thumbnail_overlay_text=data.get("thumbnail_overlay_text", ""),
            open_loops=data.get("open_loops", []),
            hook_ab=str(data.get("hook_ab", "") or "").strip(),
        )
