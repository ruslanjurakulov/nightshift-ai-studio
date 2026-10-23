"""One repair pass for the packaging texts of a script that the fact-check would hold.

Why this exists (evidence, Actions run 40005569676, a real private Chronos run)
------------------------------------------------------------------------------
Once the fact-checker started returning real verdicts, 37 of 42 claims were ``likely_accurate`` and the
five flagged ones were all PACKAGING the generator wrote, not narration: an alternate opening
("...a secret 16th-century map had the real location covered up the entire time."), the title and its A/B
variant ("...Could Solve America's Oldest Mystery") and the thumbnail text ("SECRET MAP FOUND!"). The
generator asserts secrecy, discovery, resolution and proof that nothing supports, the gate is right to
hold those, and so many runs would be held for packaging alone.

Two changes, both here:

* ``PACKAGING_CLAIM_RULE``: the rule the packaging prompts carry (script_engine, title_planner and the
  repair prompt below). A prompt change: its effect on real model output is NOT measured.
* ``repair_packaging``: when the fact-check blocks ONLY on packaging texts, rewrite exactly those texts
  ONCE, feeding the flagged text and the checker's own reasoning back to the generator, and run the same
  fact-checker (and the same grounding step) on the rewritten claims only.

What it never does
------------------
It never touches narration, never changes a verdict (every verdict of the second round is the checker's own;
an unchanged text keeps its old one), never loosens or bypasses the gate (the repaired script goes through
the SAME ``publish_gate.evaluate_fact_check`` the first one did), and never loops: there is one generation
call and at most one fact-check batch per run, and a rewrite that is still flagged ends in the same hold as
before, with both versions recorded. It is a function of injected callables so the pipeline decides what a
call costs and a test needs no network. Switch: ``NIGHTSHIFT_PACKAGING_REPAIR`` (ON unless one of off / 0 /
false / no / disabled / disable / none).
"""

from __future__ import annotations

import copy
import json
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Callable, Optional

from modules.claim_extractor import (
    SOURCE_DESCRIPTION, SOURCE_HOOK_AB, SOURCE_HOOK_SENTENCE, SOURCE_THUMBNAIL, SOURCE_TITLE, SOURCE_TITLE_AB,
    _normalize, _strip_cue_tags,
)

logger = logging.getLogger(__name__)

ENV = "NIGHTSHIFT_PACKAGING_REPAIR"
OFF_WORDS = frozenset({"0", "false", "no", "off", "disabled", "disable", "none"})
_ON_WORDS = frozenset({"", "1", "true", "yes", "on", "enabled", "enable"})

#: Cost-ledger stage of the one generation call.
STAGE = "packaging_repair"

#: The shipped texts a viewer reads before the video, as the claim extractor names their ``source``, and the
#: ``Script`` field each one lives in. Narration (``SOURCE_NARRATION``) is deliberately absent.
FIELD_OF_SOURCE = {
    SOURCE_HOOK_AB: "hook_ab",
    SOURCE_HOOK_SENTENCE: "hook_sentence",
    SOURCE_TITLE: "title",
    SOURCE_TITLE_AB: "title_ab",
    SOURCE_DESCRIPTION: "description",
    SOURCE_THUMBNAIL: "thumbnail_overlay_text",
}
PACKAGING_SOURCES = frozenset(FIELD_OF_SOURCE)

#: At most this many new claims are re-checked: one fact-check batch (modules/fact_checker.MAX_BATCH_SIZE).
MAX_RECHECKED_CLAIMS = 30
#: The longest rewrite taken (a description is the longest packaging text), and the record's caps.
MAX_REWRITE_CHARS = 5000
MAX_TITLE_CHARS = 100          # what YouTube accepts (publish_gate.MAX_TITLE_CHARS)
MAX_THUMBNAIL_WORDS = 6        # the prompt says 4; a little slack, a runaway line is refused
MAX_RECORDED_TEXT = 600
MAX_RECORDED_ITEMS = 20

PACKAGING_CLAIM_RULE = (
    "PACKAGING CLAIMS RULE (title, title_ab, hook_ab, hook_sentence, description, thumbnail_overlay_text): "
    "these texts are read before the video and each one is fact-checked on its own, as a claim. Do not claim "
    "secrecy, discovery, resolution or proof in them (secret, hidden, found, discovered, solved, revealed, "
    "finally, proof, proven, exposed, \"the truth\", \"the real reason\", \"nobody knew\") unless the research "
    "notes in this prompt say exactly that. An unsolved or disputed question stays a question: prefer a "
    "question or a hedged-but-true framing (\"Why the Roanoke Map Still Puzzles Historians\", \"What a "
    "Covered-Up Mark Might Mean\"). Never present a hypothesis as a finding, never call something new, newly "
    "found or previously unknown unless the notes say so, and state only what is documented. Everything "
    "else about the style stays as above (title: max 80 characters; thumbnail text: max 4 words; the "
    "opening still starts from the most gripping moment that is TRUE)."
)


def enabled(env=None) -> bool:
    """Is the repair pass on? ON by default; only an explicit off word turns it off.

    The deploy writes ``KEY=`` for every variable, so an empty value is the default (ON). An unrecognised
    value keeps ON and says so, without echoing it. Off restores the pipeline exactly as it was."""
    raw = str((os.environ if env is None else env).get(ENV, "") or "").strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
        raw = raw[1:-1]
    raw = raw.strip().lower()
    if raw in OFF_WORDS:
        return False
    if raw not in _ON_WORDS:
        logger.warning("%s has an unrecognised value - the packaging repair stays ON. To switch it off write one "
                       "of: %s", ENV, ", ".join(sorted(OFF_WORDS)))
    return True


# ── when a repair is allowed ──────────────────────────────────────────────────

def flagged_packaging(decision, claims, results) -> tuple:
    """``(indexes, reason)``: the positions of the flagged packaging claims when this hold is repairable,
    else ``([], fixed word)`` saying why not.

    Repairable means ALL of: the early decision blocks on nothing but ``fact_check_flagged:N`` (a block for
    a shipped figure, a title the platform would refuse, a missing check or an unreadable batch is not a
    packaging-wording problem); no result is the checker's "could not read my own answer" sentinel; and
    every flagged claim, without exception, ships in a packaging text. One flagged narration sentence and
    the run is held as before: this pass never edits what the narrator says."""
    blocks = list(getattr(decision, "blocks", None) or [])
    if len(blocks) != 1 or not str(blocks[0]).startswith("fact_check_flagged:"):
        return [], "other_blocks"
    claims, results = list(claims or []), list(results or [])
    if not claims or len(claims) != len(results):
        return [], "claims_misaligned"
    indexes = []
    for i, (claim, result) in enumerate(zip(claims, results)):
        if getattr(result, "unresolved", False):
            return [], "unresolved"
        if not getattr(result, "requires_human_review", False):
            continue
        if getattr(claim, "source", "narration") not in PACKAGING_SOURCES:
            return [], "narration_flagged"
        indexes.append(i)
    return (indexes, "") if indexes else ([], "nothing_flagged_in_packaging")


# ── the generation prompt ─────────────────────────────────────────────────────

_FIELD_STYLE = {
    "title": "YouTube title, start with a number or a power word, max 80 characters.",
    "title_ab": "Alternative A/B test title, max 80 characters.",
    "hook_ab": ("An ALTERNATE opening for the first section: the first 15-30 seconds, spoken narration with the "
                "same [PAUSE]/[SFX]/[MUSIC] cues as before, still starting from the most gripping moment that "
                "is true."),
    "hook_sentence": "The 3-second hook sentence, from the most gripping moment that is true.",
    "thumbnail_overlay_text": "Short punchy text for the thumbnail, max 4 words.",
    "description": ("YouTube description: keep its paragraphs, hashtags and every line that was not flagged as "
                    "they are; change only the flagged statements. Use no number or year the narration does "
                    "not state."),
}

REPAIR_SYSTEM = (
    "You are a careful YouTube packaging editor. An independent fact-checker flagged some of a video's "
    "packaging texts because they assert more than the evidence supports. You rewrite ONLY those texts so "
    "that they assert only what the narration and the research notes support, keeping the style, the "
    "language and the length limits. Reply with JSON only."
)


def build_prompt(topic: str, language: str, narration: str, research_notes: str, items: list) -> str:
    """The one repair prompt. ``items``: ``[{field, current, flagged: [{text, verdict, reasoning}]}]``."""
    asked = [{"field": it["field"], "style": _FIELD_STYLE.get(it["field"], ""), "current_text": it["current"],
              "flagged_because": it["flagged"]} for it in items]
    keys = ", ".join(f'"{it["field"]}"' for it in items)
    return (
        f"Topic: {topic}\nLanguage: {language or 'English'}\n\n"
        f"{PACKAGING_CLAIM_RULE}\n\n"
        "The fact-checker flagged each text below. For every item, write a version that asserts only what is "
        "supported by the narration or the research notes: hedge, ask a question, or state only what is "
        "documented. Do not make it blander than it has to be, and do not add a claim the narration does "
        "not back.\n\n"
        f"Items to rewrite (JSON):\n{json.dumps(asked, ensure_ascii=False, indent=1)}\n\n"
        f"What the video actually says (narration):\n{narration}\n"
        f"{research_notes}\n\n"
        f"Return ONLY a JSON object with exactly these keys: {keys}. Each value is the rewritten text, a "
        "plain string."
    )


def _parse_rewrites(text: str, asked: set) -> dict:
    """The rewritten strings the model gave for the fields asked, else ``{}``. Strict: a key that was not
    asked for, a non-string and an empty string are all dropped; nothing is invented."""
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", (text or "").strip(), flags=re.MULTILINE)
    try:
        data = json.loads(cleaned)
    except (ValueError, TypeError):
        match = re.search(r"\{[\s\S]+\}", cleaned)
        try:
            data = json.loads(match.group()) if match else None
        except (ValueError, TypeError):
            data = None
    if not isinstance(data, dict):
        return {}
    out = {}
    for name in asked:
        value = data.get(name)
        if isinstance(value, str) and value.strip():
            out[name] = value.strip()
    return out


def _acceptable(name: str, value: str) -> bool:
    """A rewrite the platform or the thumbnail could not take is refused here (the text then stays flagged and
    the run is held as before) rather than trusted to a later check."""
    if len(value) > MAX_REWRITE_CHARS:
        return False
    if name in ("title", "title_ab"):
        return len(value) <= MAX_TITLE_CHARS and "<" not in value and ">" not in value and "\n" not in value
    if name == "thumbnail_overlay_text":
        return len(value.split()) <= MAX_THUMBNAIL_WORDS and "\n" not in value
    if name == "hook_sentence":
        return "\n" not in value
    return True


# ── the pass ──────────────────────────────────────────────────────────────────

@dataclass
class Repair:
    """What one repair attempt did. ``record`` is what ``hold_detail.packaging_repair`` keeps."""

    status: str
    record: dict
    #: Set only when ``status == "repaired"``: the Script fields to ship, the claims and results that
    #: now describe the script, and the early gate's decision on them.
    fields: dict = field(default_factory=dict)
    claims: list = field(default_factory=list)
    results: list = field(default_factory=list)
    decision: object = None

    @property
    def passed(self) -> bool:
        return self.status == "repaired"


def _key(claim) -> tuple:
    return (claim.source, claim.section_index, _normalize(claim.text))


def _entries(claims, results, indexes=None) -> list:
    """The flagged-claim entries of ``held_video.flagged_claims``, for the given claims."""
    from modules import held_video

    pairs = [(c, r) for i, (c, r) in enumerate(zip(claims, results)) if indexes is None or i in indexes]
    return held_video.flagged_claims([c for c, _ in pairs], [r for _, r in pairs])


def _clip(text) -> str:
    return str(text or "")[:MAX_RECORDED_TEXT]


def repair_packaging(*, script, claims, results, decision, topic: str, language: Optional[str],
                     research_notes: str, generate: Callable, check: Callable, ground: Callable,
                     extract: Callable, evaluate: Callable) -> Optional[Repair]:
    """Rewrite the flagged packaging texts once and re-check only the rewritten claims.

    ``generate(prompt) -> response`` (its ``.text`` is read; the caller records its cost);
    ``check(texts) -> results`` is the SAME fact-checker; ``ground(claims, results) -> (results, summary)``
    the same grounding step (or a pass-through); ``extract(script) -> claims`` the same claim extractor;
    ``evaluate(script, claims, results) -> decision`` the same early gate. Returns ``None`` when the hold is
    not repairable (see ``flagged_packaging``): nothing was called and the caller holds exactly as before.
    Otherwise a ``Repair``: ``passed`` only when the gate now allows the run. Never raises.

    Budget: one ``generate`` call; one ``check`` call, and only when the rewrite produced claims that were
    not already checked; ``ground`` once with the same claims. Nothing here ever runs twice."""
    indexes, why = flagged_packaging(decision, claims, results)
    if not indexes:
        logger.info("Packaging repair not attempted (%s)", why)
        return None
    record: dict = {"attempted": True, "status": "", "first_round": _entries(claims, results, set(indexes)),
                    "rewrites": [], "calls": {"generation": 0, "fact_check": 0}}
    try:
        return _repair(script, claims, results, indexes, record, topic, language, research_notes,
                       generate, check, ground, extract, evaluate)
    except Exception as exc:                          # never raises into the run: the hold stays as it was
        logger.warning("Packaging repair failed (%s) - the run is held as without it", type(exc).__name__)
        record["status"] = f"error:{type(exc).__name__}"
        return Repair(record["status"], record)


def _repair(script, claims, results, indexes, record, topic, language, research_notes,
            generate, check, ground, extract, evaluate) -> Repair:
    by_field: dict = {}
    for i in indexes:
        name = FIELD_OF_SOURCE[claims[i].source]
        by_field.setdefault(name, []).append(
            {"text": claims[i].text, "verdict": getattr(results[i], "verdict", ""),
             "reasoning": str(getattr(results[i], "reasoning", "") or "")[:300]})
    items = [{"field": name, "current": str(getattr(script, name, "") or ""), "flagged": flagged}
             for name, flagged in by_field.items()]
    narration = _strip_cue_tags(script.full_narration()) if hasattr(script, "full_narration") else ""
    prompt = build_prompt(topic, language or "", narration, research_notes, items)

    record["calls"]["generation"] = 1
    try:
        response = generate(prompt)
        text = getattr(response, "text", "") or ""
    except Exception as exc:
        logger.warning("Packaging repair: the rewrite call failed (%s) - holding as before", type(exc).__name__)
        record["status"] = "generation_failed"
        return Repair("generation_failed", record)

    rewritten = _parse_rewrites(text, set(by_field))
    if not rewritten:
        record["status"] = "unusable_rewrite"
        return Repair("unusable_rewrite", record)
    fields = {}
    for name, value in rewritten.items():
        before = str(getattr(script, name, "") or "")
        if _normalize(value) == _normalize(before) or not _acceptable(name, value):
            continue
        fields[name] = value
        record["rewrites"].append({"field": name, "before": _clip(before), "after": _clip(value)})
    if not fields:
        record["status"] = "no_usable_rewrite"
        return Repair("no_usable_rewrite", record)

    repaired = copy.deepcopy(script)
    for name, value in fields.items():
        setattr(repaired, name, value)
    new_claims = list(extract(repaired))
    known = {_key(c): r for c, r in zip(claims, results)}
    fresh = [c for c in new_claims if _key(c) not in known]
    if len(fresh) > MAX_RECHECKED_CLAIMS:
        record["status"] = "too_many_claims"
        return Repair("too_many_claims", record)
    new_results: dict = {}
    if fresh:
        record["calls"]["fact_check"] = 1
        checked = list(check([c.text for c in fresh]))
        if len(checked) != len(fresh):
            record["status"] = "recheck_misaligned"
            return Repair("recheck_misaligned", record)
        checked, summary = ground(fresh, checked)
        checked = list(checked)
        if len(checked) != len(fresh):
            record["status"] = "recheck_misaligned"
            return Repair("recheck_misaligned", record)
        new_results = {_key(c): r for c, r in zip(fresh, checked)}
        if isinstance(summary, dict):
            record["grounding"] = summary
    merged_results = [known[_key(c)] if _key(c) in known else new_results[_key(c)] for c in new_claims]
    record["rechecked"] = len(fresh)

    gate = evaluate(repaired, new_claims, merged_results)
    still = [i for i, (c, r) in enumerate(zip(new_claims, merged_results))
             if getattr(r, "requires_human_review", False) and not getattr(r, "unresolved", False)]
    record["blocks_after"] = [str(b) for b in (getattr(gate, "blocks", None) or [])]
    if getattr(gate, "allowed", False):
        record["status"] = "repaired"
        record["still_flagged"] = []
        return Repair("repaired", record, fields=fields, claims=new_claims, results=merged_results, decision=gate)
    # "still_flagged": the fact-check still blocks. Anything else (a title over the limit, a shipped figure
    # the rewrite introduced) is a different block, named in ``blocks_after``.
    record["status"] = ("still_flagged" if any(str(b).startswith("fact_check_flagged:")
                                               for b in record["blocks_after"]) else "blocked_after_repair")
    record["still_flagged"] = _entries(new_claims, merged_results, set(still))[:MAX_RECORDED_ITEMS]
    return Repair(record["status"], record)
