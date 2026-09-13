"""Historical Research Engine — gathers structured research on a topic before
script-writing begins.

IMPORTANT — READ BEFORE USING THIS MODULE'S OUTPUT:
Gemini has no live web-search / retrieval tool wired into this project. Every
fact this module returns is the model's own trained-in recall, produced from
memory at generation time. It is NOT grounded, verified research — nothing
here has been checked against a source, and nothing here should be presented
to a viewer (or trusted by downstream code) as verified fact.

To keep that honest, every claim carries the model's own self-assessed
confidence ("high" | "medium" | "low") and an optional caveat describing why
it might be wrong (e.g. "date disputed", "single detail, unverified"). The
prompt explicitly tells Gemini to flag uncertainty rather than inventing
confident-sounding dates, names, or sources it isn't sure about, and this
module deliberately does NOT expose a "sources" or "citations" field — the
model has no real sources to cite, and giving it such a field would only
invite fabricated ones.

Real grounding — actual web search, retrieval, or citation verification — is
explicitly NOT built here. It is a separate, follow-up piece of work; this
module is the "ask the model what it recalls, and make it show its
uncertainty" step that should feed into (and be superseded in rigor by) that
future grounding layer.
"""

import json
import logging
import re

from config import GEMINI_MODEL, GEMINI_STRUCTURED_OUTPUT
from dataclasses import dataclass, field
from modules.gemini_client import generate_with_retry, make_client
from modules.structured_output import json_config, parse_structured

logger = logging.getLogger(__name__)

VALID_CONFIDENCE_LEVELS = {"high", "medium", "low"}

# response_schema for the schema-constrained path (roadmap #50). Deliberately
# has no "sources"/"citations" property — the model has none, and the prose
# prompt's ban on inventing them is enforced here by simply not offering a
# field for them. OpenAPI-subset dict; the google-genai SDK accepts it as-is.
RESEARCH_SCHEMA = {
    "type": "object",
    "properties": {
        "key_facts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "claim": {"type": "string"},
                    "confidence": {
                        "type": "string",
                        "enum": ["high", "medium", "low"],
                    },
                    "caveat": {"type": "string"},
                },
                "required": ["claim", "confidence"],
            },
        },
        "open_questions": {"type": "array", "items": {"type": "string"}},
        "suggested_angle": {"type": "string"},
    },
    "required": ["key_facts", "open_questions", "suggested_angle"],
}

RESEARCH_SYSTEM_PROMPT = (
    "You are a research assistant helping draft a history-mysteries YouTube "
    "script. You have NO access to web search, citations, or any live "
    "retrieval tool — everything you produce comes only from your own "
    "trained-in memory, which may be incomplete, outdated, or wrong. "
    "Do NOT invent confident-sounding dates, names, numbers, or sources you "
    "are not actually sure about. For every claim, honestly self-rate your "
    "confidence as 'high', 'medium', or 'low', and add a short caveat "
    "whenever the claim is disputed, approximate, or a single unverified "
    "detail. If you are not genuinely confident in a claim, mark it 'low' "
    "rather than guessing high. List any genuinely uncertain or contested "
    "points as open questions instead of asserting them as facts. Never "
    "fabricate a source or citation — you have none, so do not include any."
)


@dataclass
class ResearchFact:
    """A single claim recalled by the model.

    This is UNVERIFIED LLM RECALL, not a checked fact. `confidence` is the
    model's own self-assessment ("high"/"medium"/"low") of how sure it is,
    clamped to "low" by this module if the model returns anything else.
    `caveat` is an optional short note on why the claim might be wrong or
    disputed (e.g. "date disputed", "single detail, unverified"); it is None
    when the model offered no caveat.
    """

    claim: str
    confidence: str
    caveat: str | None = None


@dataclass
class ResearchBrief:
    """Unverified research summary for a topic, produced purely from the
    model's trained-in recall — no web search, retrieval, or citation
    checking was performed to produce it. Treat every entry in `key_facts`
    as a claim to double-check, not an established fact. `open_questions`
    lists points the model itself flagged as genuinely uncertain or
    contested. `suggested_angle` is a short editorial framing suggestion for
    the script, not a factual claim.
    """

    topic: str
    key_facts: list[ResearchFact] = field(default_factory=list)
    open_questions: list[str] = field(default_factory=list)
    suggested_angle: str = ""


def _clamp_confidence(raw) -> str:
    value = str(raw).strip().lower() if raw is not None else ""
    if value not in VALID_CONFIDENCE_LEVELS:
        logger.warning(
            "Research engine: Gemini returned invalid confidence %r — clamping to 'low'.",
            raw,
        )
        return "low"
    return value


def _extract_json(text: str) -> dict:
    text = re.sub(r"^```(?:json)?\s*", "", text.strip(), flags=re.MULTILINE)
    text = re.sub(r"\s*```$", "", text.strip(), flags=re.MULTILINE)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]+\}", text)
        if match:
            return json.loads(match.group())
        raise


def _parse_brief(topic: str, data: dict) -> ResearchBrief:
    key_facts = []
    for item in data.get("key_facts", []) or []:
        if not isinstance(item, dict):
            continue
        claim = str(item.get("claim", "")).strip()
        if not claim:
            continue
        caveat = item.get("caveat")
        caveat = str(caveat).strip() if caveat else None
        key_facts.append(
            ResearchFact(
                claim=claim,
                confidence=_clamp_confidence(item.get("confidence")),
                caveat=caveat or None,
            )
        )

    open_questions = [
        str(q).strip()
        for q in (data.get("open_questions", []) or [])
        if str(q).strip()
    ]

    suggested_angle = str(data.get("suggested_angle", "") or "").strip()

    return ResearchBrief(
        topic=topic,
        key_facts=key_facts,
        open_questions=open_questions,
        suggested_angle=suggested_angle,
    )


def _build_prompt(topic: str, niche: str) -> str:
    return (
        f"Topic: {topic}\n"
        f"Niche: {niche}\n\n"
        "Recall what you know about this topic from your training data and "
        "structure it as a research brief for a YouTube script writer. "
        "Return ONLY a single JSON object (no markdown fences, no commentary) "
        "with exactly this shape:\n"
        "{\n"
        '  "key_facts": [\n'
        '    {"claim": "<a specific factual claim>", '
        '"confidence": "high|medium|low", '
        '"caveat": "<short caveat or null if none>"}\n'
        "  ],\n"
        '  "open_questions": ["<a genuinely uncertain or contested point>"],\n'
        '  "suggested_angle": "<a short editorial framing suggestion for the script>"\n'
        "}\n\n"
        "Rules:\n"
        "- Every fact needs an honest, self-assessed confidence level — do not "
        "default everything to 'high'.\n"
        "- Use 'caveat' for anything disputed, approximate, or a single "
        "unverified detail.\n"
        "- Put anything you are not confident enough to state as fact into "
        "'open_questions' instead.\n"
        "- Do NOT include a 'sources' or 'citations' field — you have no real "
        "sources, so do not invent any.\n"
        "- Return valid JSON only."
    )


def research_topic(topic: str, niche: str = "history mysteries") -> ResearchBrief:
    """Ask Gemini to recall what it knows about `topic` and structure it into
    a ResearchBrief.

    This is UNVERIFIED LLM RECALL — see the module docstring. On a malformed
    or unparseable response, this does not raise; it logs an error and
    returns an empty-but-valid ResearchBrief so a single bad LLM response
    never crashes the pipeline.
    """
    client = make_client()
    prompt = _build_prompt(topic, niche)

    # Roadmap #50 spike: when opted in, constrain the model to the schema and
    # read response.parsed instead of regex-extracting JSON from prose. The
    # config builder returns None if the genai types are unavailable, so we
    # fall back to today's system-instruction config either way.
    structured = GEMINI_STRUCTURED_OUTPUT
    config = json_config(RESEARCH_SCHEMA, system_instruction=RESEARCH_SYSTEM_PROMPT) if structured else None
    if config is None:
        structured = False
        config = _system_config(RESEARCH_SYSTEM_PROMPT)

    response = generate_with_retry(client, GEMINI_MODEL, prompt, config)

    try:
        data = parse_structured(response) if structured else _extract_json(response.text)
        return _parse_brief(topic, data)
    except (json.JSONDecodeError, ValueError, AttributeError) as exc:
        logger.error(
            "Research engine: could not parse Gemini response for topic %r (%s). "
            "Returning empty ResearchBrief.",
            topic, exc,
        )
        return ResearchBrief(
            topic=topic, key_facts=[], open_questions=[], suggested_angle=""
        )


def _system_config(system_instruction: str):
    """Build a GenerateContentConfig carrying the system instruction, tolerating
    environments where the genai types module isn't importable (kept optional
    so a missing/renamed type never breaks this module's import)."""
    try:
        from google.genai import types as genai_types
    except ImportError:  # pragma: no cover - defensive only
        return None
    return genai_types.GenerateContentConfig(system_instruction=system_instruction)
