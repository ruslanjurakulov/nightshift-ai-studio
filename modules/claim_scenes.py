"""Claim <-> scene linkage — which scene says what, and what the checker thought.

*** ADVISORY ONLY. *** Every status here comes from ``modules/fact_checker``,
which is an advisory second opinion that feeds the Final Human Approval stage
and must never replace it (see that module's banner). This module only
*arranges* those opinions by scene so a reviewer can see, in the Storyboard,
which claim sits in which scene. It decides nothing, gates nothing, and the
publish gate (``publish_gate._check_fact_results``) is untouched.

What it produces
----------------
* ``fact_check_records(claims, results)`` — the ``fact_check.json`` rows: the
  fact-checker's fields plus ``claim_id``, ``section_index`` and ``scene_id``.
  Existing readers (tools/approve_run.py, notifier) read only the old keys.
* ``annotate_scenes(script, claims, results)`` — ``Script.scene_plan()`` with,
  per scene, ``id`` (``s000``), ``claim_ids`` and ``claims`` (each with its
  ``status`` and ``requires_human_review``). This is what is stored with the
  video (``videos.scenes``, migration 0011 — jsonb, so no schema change).

Honesty rules
-------------
* A claim's status is the checker's verdict for *that exact sentence in that
  section*. The scene's claims are re-read from the narration that actually
  shipped: when the narration changed after the check (the hook A/B "B" arm
  swaps the opening after fact-checking), a sentence that was never checked is
  listed as ``not_checked`` — never borrowed from a different sentence.
* ``not_checked`` (the checker did not run, crashed, or never saw the sentence)
  is not a verdict and never reads as accurate: ``requires_human_review`` is
  True for it, exactly like ``unverifiable``.
* Never raises. Any failure returns the plain scene plan, as before.
"""

from __future__ import annotations

import logging
import re
from typing import Iterable, Optional

from modules.claim_extractor import Claim, claim_id as make_claim_id, scene_id, section_claims

logger = logging.getLogger(__name__)

STATUS_NOT_CHECKED = "not_checked"


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()


def fact_check_records(claims: Optional[Iterable[Claim]], results) -> list[dict]:
    """The rows written to ``output/<slug>/fact_check.json``.

    ``results`` is ``fact_checker.fact_check_claims([c.text for c in claims])``
    — same order. Each row keeps the checker's own fields and adds the claim's
    id and scene. If the two lists somehow differ in length, only the aligned
    prefix gets ids (a result is never paired with the wrong claim)."""
    claims = list(claims or [])
    rows = []
    for i, r in enumerate(results or []):
        row = dict(getattr(r, "__dict__", {}) or {})
        if i < len(claims) and _norm(claims[i].text) == _norm(row.get("claim", "")):
            row["claim_id"] = claims[i].claim_id
            row["section_index"] = claims[i].section_index
            row["scene_id"] = claims[i].scene_id
        rows.append(row)
    return rows


def _checked_index(claims, results) -> dict:
    """(section_index, normalized text) -> (claim_id, verdict, reasoning, review)."""
    index: dict = {}
    if results is None:
        return index
    for claim, r in zip(list(claims or []), list(results or [])):
        text = _norm(getattr(r, "claim", ""))
        if text != _norm(claim.text):
            continue   # misaligned — never pair a verdict with another sentence
        index[(claim.section_index, text)] = (
            claim.claim_id,
            getattr(r, "verdict", None),
            getattr(r, "reasoning", "") or "",
            bool(getattr(r, "requires_human_review", True)),
        )
    return index


def annotate_scenes(script, claims: Optional[Iterable[Claim]], results) -> list:
    """``script.scene_plan()`` with each scene's id, claim ids and claims.

    ``claims``/``results`` are what the fact-check stage produced (either may be
    None when that stage failed). Never raises: on any error the plain scene
    plan comes back, exactly as before this module existed."""
    try:
        plan = script.scene_plan()
    except Exception as e:
        logger.warning("Could not build the scene plan (%s: %s)", type(e).__name__, e)
        return []
    try:
        checked = _checked_index(claims, results)
        out = []
        for i, scene in enumerate(plan):
            scene = dict(scene)
            scene.setdefault("id", scene_id(i))
            shipped = section_claims(scene.get("narration") or "", i)
            scene_claims = []
            unchecked_n = 0
            for claim in shipped:
                hit = checked.get((i, _norm(claim.text)))
                if hit is not None:
                    cid, verdict, reasoning, review = hit
                    scene_claims.append({
                        "id": cid, "text": claim.text, "status": verdict,
                        "reasoning": reasoning, "requires_human_review": review,
                    })
                else:
                    unchecked_n += 1
                    # A sentence the checker never saw: its own id space so it
                    # can never collide with a checked claim's id.
                    scene_claims.append({
                        "id": f"{make_claim_id(i, unchecked_n)}u",
                        "text": claim.text, "status": STATUS_NOT_CHECKED,
                        "reasoning": "", "requires_human_review": True,
                    })
            scene["claim_ids"] = [c["id"] for c in scene_claims]
            scene["claims"] = scene_claims
            out.append(scene)
        return out
    except Exception as e:
        logger.warning("Could not link claims to scenes (%s: %s) — storing the plain plan",
                       type(e).__name__, e)
        return plan
