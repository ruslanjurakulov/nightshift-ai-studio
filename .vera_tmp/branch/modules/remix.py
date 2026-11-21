"""Viral Remix — the eligibility gate and plan for a rights-clean remix.

What this is, and deliberately is not
-------------------------------------
"Remix" here is a NEW video built by re-editing or commenting on existing
footage, rather than researched from a topic. That is a powerful growth lever
and a legal minefield, so this module is written as the **gatekeeper**, not the
downloader or the uploader:

  * It decides whether a proposed remix is even *eligible* to be built, from the
    rights the operator asserts over the source — and refuses anything with no
    asserted basis. It never assumes fair use on the operator's behalf.
  * It produces a *plan* — which source, in which mode, with the attribution the
    licence requires — that the normal pipeline then executes. It fetches
    nothing and uploads nothing itself.
  * Its output is still a video, so it still passes the SAME pre-publish gate
    (originality + fact-check + sanity, modules/publish_gate.py). `gate_required`
    is always True here; nothing in remix can weaken or skip that gate.

Two source paths (roadmap #43), and the boundary between them
-------------------------------------------------------------
  * **Compilation** — recompose the channel's OWN published videos (a "best of",
    a re-cut, a themed montage). Rights are clean because the channel made them,
    so this path is allowed ONLY for `owned` + `own_catalog` sources.
  * **Commentary** — a new, transformative work (original narration/analysis)
    that references external material. Allowed only when the operator asserts a
    rights basis (`owned`, `licensed`, or `cc_by`); `cc_by`/`licensed` also
    carry a required attribution line. A source with `none` asserted is refused —
    the code will not greenlight unlicensed reuse.

Off by default. `AgentConfig.remix_enabled` is opt-in (only an explicit true
turns it on); an un-configured channel behaves exactly as before. Pure and
deterministic — no network, no moviepy — so the eligibility rules are fully
unit-testable; wiring a plan into the render path is a separate, gated follow-up.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

# -- rights the operator asserts over a source ------------------------------
RIGHTS_OWNED = "owned"        # the channel produced it
RIGHTS_LICENSED = "licensed"  # a paid/explicit licence covers this use
RIGHTS_CC_BY = "cc_by"        # Creative Commons requiring attribution
RIGHTS_NONE = "none"          # no basis asserted — never eligible

_RIGHTS_WITH_BASIS = (RIGHTS_OWNED, RIGHTS_LICENSED, RIGHTS_CC_BY)
_RIGHTS_NEEDING_ATTRIBUTION = (RIGHTS_LICENSED, RIGHTS_CC_BY)

# -- source origin ----------------------------------------------------------
ORIGIN_OWN_CATALOG = "own_catalog"  # one of this channel's own published videos
ORIGIN_EXTERNAL = "external"        # anything not made by this channel

# -- remix modes ------------------------------------------------------------
MODE_COMPILATION = "compilation"  # re-edit of owned catalogue
MODE_COMMENTARY = "commentary"    # transformative new work over a reference


@dataclass(frozen=True)
class RemixSource:
    """A candidate piece of source material and the rights asserted over it.

    `rights` and `origin` are the operator's assertions — this module trusts
    them to *refuse* (no basis → not eligible), never to manufacture a basis.
    """
    source_id: str
    title: str = ""
    rights: str = RIGHTS_NONE
    origin: str = ORIGIN_EXTERNAL
    url: Optional[str] = None
    #: Who to credit. Required for licensed/cc_by; ignored otherwise.
    creator: Optional[str] = None


@dataclass(frozen=True)
class RemixEligibility:
    allowed: bool
    reason: str
    requires_attribution: bool
    #: Always True. A remix is a video; the pre-publish gate still decides.
    gate_required: bool = True

    def to_dict(self) -> dict:
        return {
            "allowed": self.allowed,
            "reason": self.reason,
            "requires_attribution": self.requires_attribution,
            "gate_required": self.gate_required,
        }


def _norm(value: Optional[str]) -> str:
    return (value or "").strip().lower()


def evaluate_eligibility(source: RemixSource, mode: str) -> RemixEligibility:
    """Whether this source may be remixed in this mode. Never raises.

    Refuses — rather than assuming a right — whenever no basis is asserted, and
    keeps `compilation` to the channel's own catalogue. Attribution is flagged
    (never invented) for licensed/CC-BY material.
    """
    rights = _norm(source.rights)
    origin = _norm(source.origin)
    m = _norm(mode)
    needs_attr = rights in _RIGHTS_NEEDING_ATTRIBUTION

    if m == MODE_COMPILATION:
        if rights != RIGHTS_OWNED or origin != ORIGIN_OWN_CATALOG:
            return RemixEligibility(
                allowed=False,
                reason="Compilation only recomposes this channel's own published videos.",
                requires_attribution=False,
            )
        return RemixEligibility(
            allowed=True,
            reason="Own-catalogue compilation — rights are the channel's own.",
            requires_attribution=False,
        )

    if m == MODE_COMMENTARY:
        if rights not in _RIGHTS_WITH_BASIS:
            return RemixEligibility(
                allowed=False,
                reason="Commentary needs an asserted rights basis (owned, licensed, or CC-BY); none was given.",
                requires_attribution=False,
            )
        if needs_attr and not (source.creator and source.creator.strip()):
            return RemixEligibility(
                allowed=False,
                reason=f"{rights} material requires an attribution; no creator was named.",
                requires_attribution=True,
            )
        return RemixEligibility(
            allowed=True,
            reason="Transformative commentary over a source with an asserted rights basis.",
            requires_attribution=needs_attr,
        )

    return RemixEligibility(
        allowed=False,
        reason=f"Unknown remix mode {mode!r}; expected {MODE_COMPILATION!r} or {MODE_COMMENTARY!r}.",
        requires_attribution=False,
    )


def attribution_line(source: RemixSource) -> Optional[str]:
    """The credit line a licensed/CC-BY source needs, or None when none is
    required (owned material) or possible (no creator named)."""
    if _norm(source.rights) not in _RIGHTS_NEEDING_ATTRIBUTION:
        return None
    who = (source.creator or "").strip()
    if not who:
        return None
    base = f"Source: {source.title or source.source_id} by {who}"
    if _norm(source.rights) == RIGHTS_CC_BY:
        base += " (CC BY)"
    if source.url:
        base += f" — {source.url}"
    return base


@dataclass(frozen=True)
class RemixPlan:
    mode: str
    source_id: str
    origin: str
    rights: str
    #: The credit line to place in the description, or None when not required.
    attribution: Optional[str]
    #: Always True — the produced video still faces the pre-publish gate.
    gate_required: bool = True
    notes: tuple = field(default_factory=tuple)

    def to_dict(self) -> dict:
        return {
            "mode": self.mode,
            "source_id": self.source_id,
            "origin": self.origin,
            "rights": self.rights,
            "attribution": self.attribution,
            "gate_required": self.gate_required,
            "notes": list(self.notes),
        }


def build_plan(source: RemixSource, mode: str) -> Optional[RemixPlan]:
    """A plan for an eligible remix, or None when it is not eligible.

    The plan is a description of the transformative work to build — it performs
    no download, no render, and no upload. The pipeline that later executes it
    still routes the output through the pre-publish gate.
    """
    verdict = evaluate_eligibility(source, mode)
    if not verdict.allowed:
        return None
    m = _norm(mode)
    notes = (
        "Produces a NEW transformative work, not a re-upload.",
        "Output still passes the pre-publish gate (originality + fact-check).",
    )
    if m == MODE_COMPILATION:
        notes = ("Re-edit of the channel's own published videos.",) + notes[1:]
    return RemixPlan(
        mode=m,
        source_id=source.source_id,
        origin=_norm(source.origin),
        rights=_norm(source.rights),
        attribution=attribution_line(source) if verdict.requires_attribution else None,
        notes=notes,
    )


def summarize_block(source: RemixSource, mode: str) -> dict:
    """Metadata for a `remix.blocked` event — a refused-for-rights source."""
    verdict = evaluate_eligibility(source, mode)
    return {
        "source_id": source.source_id,
        "mode": _norm(mode),
        "rights": _norm(source.rights),
        "origin": _norm(source.origin),
        "reason": verdict.reason,
    }
