"""Fact-Checking Engine — independent second pass over a script's claims.

*** ADVISORY ONLY — THIS ENGINE DOES NOT, AND MUST NEVER, REPLACE THE HUMAN ***
*** APPROVAL GATE.                                                          ***

This project's pipeline is:

    Topic -> Research -> Script -> Fact Check -> Final Human Approval -> Publish

This module implements the "Fact Check" stage. Its entire job is to FEED the
Final Human Approval stage with an independent, machine-generated opinion on
each claim so a human reviewer has something concrete to check. It has no
authority to approve, clear, or wave a script through to publish, and nothing
in this codebase should ever be wired to skip Final Human Approval based on
this engine's output alone — no matter how confident every verdict looks.

Concretely, that shows up in the code as three defaults that always err
toward "make a human look at this":

  1. Every claim whose verdict is not the highest-confidence
     "likely_accurate" defaults `requires_human_review=True`. This flag is
     never taken from the model's own output — it is always computed here,
     from the validated verdict, so a model cannot talk its way past review.
  2. Any verdict string the model returns that isn't one of the three known
     values is clamped down to "unverifiable" (never silently treated as
     "likely_accurate").
  3. Any parsing failure, malformed JSON, or a batch that can't be resolved
     even after a retry produces the safe-default sentinel:
     verdict="unverifiable", requires_human_review=True. It never defaults to
     "accurate" just because the model's response couldn't be understood.

Grounding: this module judges from the model's own recall and never sees evidence. The
evidence lookup (modules/grounding.py) runs AFTER it, reads these results, and may only
upgrade an unverifiable claim with a quote verified in code or add a flag; see
docs/GROUNDED_FACTCHECK.md.

Input contract
--------------
`fact_check_claims` takes a plain `list[str]` of claim strings. This is a
deliberate, loose-coupling choice: this module does not import any claim
dataclass or extraction logic from another module (e.g. a future
`research_engine` or `script_engine` claim-extraction helper), since those may
live on sibling branches that don't exist in this checkout. Wiring this engine
into the rest of the pipeline — extracting claims out of a generated script,
and gating the Final Human Approval UI on these results — is a follow-up, not
part of this module.
"""

import json
import logging
import re
from dataclasses import dataclass
from typing import Optional

from config import GEMINI_MODEL
from modules.gemini_client import generate_with_retry, make_client

logger = logging.getLogger(__name__)

# Gemini is called once per batch of claims. A bigger batch means fewer
# requests (cheaper, faster, fewer chances to hit a rate limit) but a bigger
# risk that a very long claim list gets truncated by the model's output
# limit or that the model loses track of an item in the middle of a huge
# list. 30 mirrors the batch sizes used elsewhere in this codebase for
# similar bulk-JSON Gemini calls (see script_engine's per-section keyword
# batching) as a reasonable middle ground; tune via this constant if claims
# turn out to run much longer or shorter than expected.
MAX_BATCH_SIZE = 30

# The only verdicts this engine will ever record. Anything else the model
# returns is clamped to "unverifiable" — see module docstring point 2.
VALID_VERDICTS = {"likely_accurate", "likely_inaccurate", "unverifiable"}

SAFE_DEFAULT_VERDICT = "unverifiable"
SAFE_DEFAULT_REASONING = (
    "Automated fact-check could not produce a resolvable verdict for this "
    "claim (parsing failure or unresolved batch after retry) — defaulting "
    "to the safe sentinel. Requires human review."
)

FACT_CHECK_SYSTEM_PROMPT = """
You are an independent fact-checking assistant reviewing claims that will be
shown to a human reviewer before anything is published. You are NOT the final
decision-maker — a human always reviews your output afterward. Your job is to
give your best independent assessment of each claim's likely factual accuracy,
plus a brief, concrete reason.

For EACH claim, decide one of exactly three verdicts:
  "likely_accurate"   — you are confident the claim is factually correct.
  "likely_inaccurate" — you believe the claim is false, misleading, or
                         exaggerated.
  "unverifiable"       — you cannot confidently assess the claim (too vague,
                         no reliable way to check, contradictory evidence,
                         outside your knowledge, etc.). Use this whenever you
                         are not confident — do not guess "likely_accurate".

Input is a JSON object: {"claims": ["claim text 0", "claim text 1", ...]}
where the array index of each claim is its identity.

Return ONLY a JSON object with this EXACT schema, with one entry per input
claim, using the SAME index as the input array (0-based) — every index from 0
to N-1 must appear exactly once, where N is the number of input claims:

{
  "results": [
    {"index": 0, "verdict": "likely_accurate", "reasoning": "Brief reason."},
    {"index": 1, "verdict": "unverifiable", "reasoning": "Brief reason."}
  ]
}

Do not omit any index. Do not add extra indices. Do not merge claims. Do not
wrap the JSON in markdown code fences.
"""


@dataclass
class FactCheckResult:
    """A single claim's independent fact-check verdict.

    `requires_human_review` is ALWAYS computed from `verdict` by this module
    (True for anything other than "likely_accurate") — it is never taken
    directly from the model's response. See the module docstring. Build
    instances through `_make_result`/`_safe_default` below rather than
    constructing this directly, so that invariant can't be bypassed.
    """

    claim: str
    verdict: str
    reasoning: str
    requires_human_review: bool
    #: True only for the safe-default sentinel: the checker could not read its own
    #: answer for this claim. That is an outage, not a verdict on the claim, so the
    #: gate counts it apart (publish_gate: ``fact_check_unresolved``).
    unresolved: bool = False
    #: What the evidence lookup (modules/grounding.py) did for this claim, or None when it had no
    #: say: the status, the effect (``upgraded`` / ``flagged`` / ``none``), the cited sources and
    #: the quote. Never set by the checker itself; the verdict above is the checker's own unless
    #: ``grounding["effect"]`` says otherwise.
    grounding: Optional[dict] = None


def _make_result(claim: str, verdict: str, reasoning: str, unresolved: bool = False) -> FactCheckResult:
    """Build a FactCheckResult, always computing requires_human_review here."""
    if verdict not in VALID_VERDICTS:
        verdict = "unverifiable"
    return FactCheckResult(
        claim=claim,
        verdict=verdict,
        reasoning=reasoning,
        requires_human_review=(verdict != "likely_accurate"),
        unresolved=unresolved,
    )


def _safe_default(claim: str) -> FactCheckResult:
    """The sentinel used whenever a claim's verdict can't be resolved."""
    return _make_result(claim, SAFE_DEFAULT_VERDICT, SAFE_DEFAULT_REASONING, unresolved=True)


def _build_prompt(batch: list[str]) -> str:
    """Build the user prompt, JSON-encoding claims into the data section.

    Claims may ultimately come from a generated script or scraped text this
    module doesn't fully control, so they are never string-interpolated
    loose into the prompt — they go through json.dumps, same defensive
    pattern used by other batched-Gemini modules in this codebase.
    """
    # The index each claim must come back under is carried IN the data, not
    # only described in the instructions. The system prompt already demanded
    # 0-based indices and the model still returned something unusable on every
    # batch of a real run, down to batches of three; asking it to echo a number
    # it can see beats asking it to derive one it cannot.
    indexed = [{"index": i, "claim": claim} for i, claim in enumerate(batch)]
    payload = json.dumps({"claims": indexed}, ensure_ascii=False)
    return (
        "Fact-check the following claims. Respond with a top-level JSON "
        "object whose single key is `results` — not a bare array, and not the "
        "`claims` key used below — holding one result per claim, each echoing "
        "that claim's own `index` value exactly as given.\n\n"
        f"{payload}"
    )


def _extract_json(text: str):
    """Parse Gemini's response text as JSON, tolerating code fences.

    Returns the decoded object — which may be a dict *or* a list, because the
    model returns both — or None (never raises) on any parsing failure.
    Callers treat None as "malformed response" and fall into the
    split-and-retry / safe-default path rather than propagating an exception.
    """
    if not text:
        return None
    cleaned = re.sub(r"^```(?:json)?\s*", "", text.strip(), flags=re.MULTILINE)
    cleaned = re.sub(r"\s*```$", "", cleaned.strip(), flags=re.MULTILINE)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    # Buried in prose. Try an object first, then a bare array — the array arm
    # matters because a top-level list is one of the shapes really returned.
    for pattern in (r"\{[\s\S]+\}", r"\[[\s\S]+\]"):
        match = re.search(pattern, cleaned)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                continue
    return None


def _locate_results(data) -> tuple[list | None, str]:
    """The list of per-claim results inside whatever envelope came back, and
    where it was found.

    Run #8 flagged 29 of 29 claims, and the diagnosis added in the previous
    change said exactly why — not the indices this time, but the envelope:

        batch of 29: top level is list, expected an object
        batch of 14: no 'results' key; top-level keys were ['claims']

    Both carried the answers. The first dropped the wrapper entirely; the
    second echoed back the key the *request* used. Refusing them threw away
    work the model had already done and blocked every publish.

    Accepted, in order: a bare list; `results`; `claims`; and — only when it is
    unambiguous — a lone list-valued key under any other name. The list is None
    when there is no list at all, or when two or more keys hold lists and
    picking one would be a guess rather than a reading.

    The second element names the envelope, so the diagnosis can report a
    response that parsed only because of a non-standard wrapper.
    """
    if isinstance(data, list):
        return data, "a bare top-level list"
    if not isinstance(data, dict):
        return None, f"top level is {type(data).__name__}"
    for key in ("results", "claims"):
        value = data.get(key)
        if isinstance(value, list):
            return value, f"{key!r}"
    lists = [(k, v) for k, v in data.items() if isinstance(v, list)]
    if len(lists) == 1:
        return lists[0][1], f"{str(lists[0][0])!r} (the only list-valued key)"
    if lists:
        return None, f"{len(lists)} list-valued keys, so no unambiguous choice"
    return None, "no list-valued key"


def _results_list(data) -> list | None:
    """`_locate_results` without the provenance, for the parser."""
    return _locate_results(data)[0]


def _coerce_index(value) -> int | None:
    """An index the model returned, as an int, or None if it isn't one.

    `True` is an int in Python and would silently read as index 1, so bools
    are rejected explicitly.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def describe_response_shape(text: str, batch_len: int) -> str:
    """What came back, described without quoting any of it.

    A malformed response used to be reported only as "malformed" — true, and
    useless: it never said whether the JSON failed to parse, the top-level key
    was different, the indices were 1-based, or half the entries were missing.
    That cost a full production run to work out. This says which, in terms of
    structure only: key names, counts, and types. No claim text, no reasoning
    text, and no verdict string is ever included, because this line is logged.
    """
    data = _extract_json(text)
    if data is None:
        return f"not parseable as JSON (received {len(text or '')} chars)"
    results, where = _locate_results(data)
    if results is None:
        if isinstance(data, dict):
            return (f"no usable list of results ({where}); "
                    f"top-level keys were {sorted(map(str, data))}")
        return f"no usable list of results ({where})"
    envelope = "" if where == "'results'" else f"read from {where}; "

    raw = [item.get("index") if isinstance(item, dict) else None for item in results]
    kinds = sorted({type(v).__name__ for v in raw})
    coerced = sorted(i for i in (_coerce_index(v) for v in raw) if i is not None)
    return (
        f"{envelope}{len(results)} result(s) for {batch_len} claim(s); "
        f"index types {kinds}; indices {coerced}"
    )


def _parse_batch_response(text: str, batch_len: int) -> dict[int, dict] | None:
    """Map the model's JSON onto claim positions, or None when it cannot be.

    The strict reading — every index 0..batch_len-1, present exactly once, as
    a JSON integer — is what a well-behaved response gives. A real production
    run showed the model failing that on every batch, so three forgiving
    readings are tried in turn, each one still order-independent and still
    refusing to guess:

    0. **The envelope.** The results list is taken from a bare top-level list,
       from `results`, from `claims`, or from a lone list-valued key — see
       `_results_list`. Two runs were lost to responses that carried every
       answer under a wrapper this refused.
    1. **String indices.** `"0"` means the same as `0`.
    2. **1-based indices.** A complete 1..N set is shifted down to 0..N-1.
       Complete-set-only, so a partial answer is never silently renumbered.
    3. **No indices at all**, with exactly one result per claim: fall back to
       position. This is the only reading that trusts ordering rather than
       verifying it — it is last, and it is logged — but without it a model
       that simply omits the field blocks every publish forever, which is a
       worse failure than the one it risks.

    Anything else returns None, and the caller splits the batch or falls back
    to the safe default. Nothing here can mark a claim accurate that the model
    did not mark accurate.
    """
    results = _results_list(_extract_json(text))
    if results is None:
        return None

    items = [item for item in results if isinstance(item, dict)]
    expected = set(range(batch_len))

    by_index: dict[int, dict] = {}
    for item in items:
        idx = _coerce_index(item.get("index"))
        if idx is None or idx in by_index:
            continue  # missing or duplicate — leaves a gap, caught below
        by_index[idx] = item

    if set(by_index) == expected:
        return by_index

    # 1-based, complete. Shift rather than reject.
    if set(by_index) == set(range(1, batch_len + 1)):
        logger.info("Fact-checker response used 1-based indices; shifted to 0-based")
        return {i - 1: item for i, item in by_index.items()}

    # No usable index anywhere, but exactly one result per claim: take order.
    if not by_index and len(items) == batch_len:
        logger.warning(
            "Fact-checker response carried no usable index for %d claim(s) — "
            "matching by position, which trusts the model's ordering",
            batch_len,
        )
        return dict(enumerate(items))

    return None


def _check_batch(client, batch: list[str], allow_split_retry: bool = True
                  ) -> list[FactCheckResult]:
    """Fact-check one batch of claims, with the split-and-retry fallback.

    On a clean, fully-indexed response, builds results directly. On a
    malformed response or one with mismatched/missing indices, splits the
    batch in half and retries each half once (`allow_split_retry=False` on
    the recursive calls, so this happens at most one level deep). Any claim
    still unresolved after that gets the safe-default sentinel rather than
    raising.
    """
    prompt = _build_prompt(batch)
    response = generate_with_retry(client, GEMINI_MODEL, prompt)
    text = getattr(response, "text", "") or ""

    by_index = _parse_batch_response(text, len(batch))

    if by_index is not None:
        results = []
        clamped = 0
        for i, claim in enumerate(batch):
            item = by_index[i]
            verdict = item.get("verdict")
            reasoning = str(item.get("reasoning", ""))
            clamped += verdict not in VALID_VERDICTS
            results.append(_make_result(claim, verdict, reasoning))
        if clamped:
            # A measurement, not a fix: a verdict outside the three words is read as "unverifiable"
            # (every such claim is then flagged). The count says whether that is why a run flagged
            # most of its claims; the strings themselves are model output and are not logged.
            logger.warning("Fact-checker returned a verdict outside the three known values for %d of %d "
                           "claim(s) in a batch; they were read as 'unverifiable'", clamped, len(batch))
        return results

    logger.warning(
        "Fact-checker got an unusable response for a batch of %d claim(s): %s%s",
        len(batch),
        describe_response_shape(text, len(batch)),
        " — splitting and retrying" if allow_split_retry and len(batch) > 1
        else " — no more retries left, using safe defaults",
    )

    if allow_split_retry and len(batch) > 1:
        mid = len(batch) // 2
        left = _check_batch(client, batch[:mid], allow_split_retry=False)
        right = _check_batch(client, batch[mid:], allow_split_retry=False)
        return left + right

    return [_safe_default(claim) for claim in batch]


def fact_check_claims(claims: list[str]) -> list[FactCheckResult]:
    """Independently assess each claim's likely factual accuracy.

    Batches `claims` into chunks of at most MAX_BATCH_SIZE, calls Gemini once
    per batch via `generate_with_retry`, and parses the structured JSON
    response into `FactCheckResult`s. See the module docstring: this is an
    advisory pass that feeds the human-approval gate — it never decides
    anything on its own.

    Returns results in the same order as `claims`. An empty input returns an
    empty list without making any API call.
    """
    if not claims:
        return []

    client = make_client()
    results: list[FactCheckResult] = []
    for start in range(0, len(claims), MAX_BATCH_SIZE):
        batch = claims[start:start + MAX_BATCH_SIZE]
        results.extend(_check_batch(client, batch))
    return results
