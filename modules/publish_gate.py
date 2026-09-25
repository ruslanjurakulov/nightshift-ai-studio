"""Pre-publish gate — the checks that can actually stop an upload.

What changed, stated plainly
----------------------------
Until now every quality signal in this project *reported*. The fact-checker
flagged claims and the pipeline uploaded anyway; the originality engine existed
and was never called before publishing; the Command Center's quality panel was
documented as "read-only: it reports, it does not gate". At one video a day on
one channel that was a survivable trade. At several channels publishing daily it
is not: a single policy strike or a duplicate-content pattern can cost a channel
permanently, and nobody is watching each upload.

So this module blocks. It is the one place in Nightshift that can prevent a
publish, and it only ever moves in the restrictive direction:

* It can stop an upload that would previously have happened.
* It can **never** cause an upload that would not have happened before, and it
  never publishes anything itself.
* It is not autonomy. It grants the pipeline no new power — it takes one away.

A blocked run still renders and keeps the video on disk. Nothing is destroyed;
a human can review and upload manually.

Turning it off
--------------
Per channel, via ``agent_config.publish_gate``:

    "publish_gate": {"enabled": false}                 # off entirely
    "publish_gate": {"block_on_fact_check": false}     # keep the rest

The measured-file checks (modules/video_qc.py: streams, duration vs narration,
truncation, black/silent runs) are part of sanity and follow
``block_on_sanity``.

The rights check (roadmap PR 4.2) reads the run's Video IR project: a USED
asset whose ``rights.status`` is ``"blocked"`` blocks (``block_on_rights``,
default on). ``"unknown"`` only warns — almost every asset is unknown until
provenance is recorded — unless the channel opts in with
``"block_on_unknown_rights": true`` (default OFF; only an explicit ``true``
turns it on).

Defaults are ON, because the failure this exists to prevent is unrecoverable
and the failure it can cause — a video that waits for a human — is not.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

#: YouTube rejects titles longer than this outright.
MAX_TITLE_CHARS = 100
#: YouTube's description limit.
MAX_DESCRIPTION_CHARS = 5000
#: A rendered file smaller than this is not a video anyone should publish.
MIN_VIDEO_BYTES = 100_000
#: Fewer sections than this is a malformed script, not a short one.
MIN_SECTIONS = 2


@dataclass
class GateDecision:
    """Why an upload may or may not proceed.

    `blocks` are the reasons it must not; `warnings` are things worth recording
    that do not stop it. `allowed` is derived, never set independently — there
    is no way to end up allowed *with* blocks.
    """

    blocks: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    checks_run: list = field(default_factory=list)
    #: The deterministic video QC report's metadata (modules/video_qc.py), when
    #: one was passed in — so the gate event carries the measurements behind
    #: any `video_qc_*` reason, not just the reason code.
    video_qc: Optional[dict] = None
    #: Rights counts from the Video IR (see `_check_rights`), when the check
    #: ran. Asset and scene ids only — never a path, URL or prompt.
    rights: Optional[dict] = None

    @property
    def allowed(self) -> bool:
        return not self.blocks

    def to_metadata(self) -> dict:
        """Event metadata. Reasons are our own strings — no script text, no
        claim text, nothing that could carry a credential."""
        meta = {
            "allowed": self.allowed,
            "blocks": list(self.blocks),
            "warnings": list(self.warnings),
            "checks_run": list(self.checks_run),
        }
        if self.video_qc is not None:
            meta["video_qc"] = self.video_qc
        if self.rights is not None:
            meta["rights"] = self.rights
        return meta


@dataclass(frozen=True)
class GateConfig:
    """Which checks are live for this channel."""

    enabled: bool = True
    block_on_duplicate: bool = True
    block_on_fact_check: bool = True
    block_on_sanity: bool = True
    #: A used IR asset with rights.status "blocked" blocks the upload.
    block_on_rights: bool = True
    #: Opt-in: a used asset whose rights are "unknown" also blocks. Default
    #: OFF — today nearly every asset is unknown, so defaulting to block would
    #: stop every video. Unknown always warns either way.
    block_on_unknown_rights: bool = False

    @staticmethod
    def from_channel(channel) -> "GateConfig":
        """Read `agent_config.publish_gate`. Anything unset stays ON: a config
        typo must not silently disable a safety check."""
        raw = {}
        try:
            agent = getattr(channel, "agent", None)
            raw = dict(getattr(agent, "publish_gate", None) or {})
        except Exception:
            raw = {}

        def flag(key: str) -> bool:
            value = raw.get(key)
            # Only an explicit boolean false turns a check off.
            return not (value is False)

        def opt_in(key: str) -> bool:
            # The opposite default, for checks that are OFF unless asked for:
            # only an explicit boolean true turns one on. Either way a typo
            # leaves the gate at least as strict as it was.
            return raw.get(key) is True

        return GateConfig(
            enabled=flag("enabled"),
            block_on_duplicate=flag("block_on_duplicate"),
            block_on_fact_check=flag("block_on_fact_check"),
            block_on_sanity=flag("block_on_sanity"),
            block_on_rights=flag("block_on_rights"),
            block_on_unknown_rights=opt_in("block_on_unknown_rights"),
        )


def evaluate(
    *,
    script,
    video_path: Optional[Path] = None,
    topic: str = "",
    fact_results: Optional[list] = None,
    channel=None,
    originality=None,
    qc_report=None,
    ir_project=None,
) -> GateDecision:
    """Decide whether this video may be uploaded.

    Never raises: a gate that crashes must not take down a pipeline that had
    already produced a video. A check that cannot run is recorded as a warning
    and does NOT block — refusing to publish because a checker was broken would
    turn every checker outage into an outage of the whole channel.
    """
    decision = GateDecision()
    config = GateConfig.from_channel(channel)
    if not config.enabled:
        decision.warnings.append("gate_disabled_for_channel")
        return decision

    _check_sanity(decision, config, script, video_path)
    _check_video_qc(decision, config, video_path, qc_report)
    _check_fact_results(decision, config, fact_results)
    _check_originality(decision, config, topic or getattr(script, "topic", ""), originality)
    _check_rights(decision, config, ir_project)
    return decision


def _check_sanity(decision: GateDecision, config: GateConfig, script, video_path) -> None:
    """Things YouTube or a viewer would reject outright."""
    decision.checks_run.append("sanity")
    try:
        title = (getattr(script, "title", "") or "").strip()
        description = getattr(script, "description", "") or ""
        sections = getattr(script, "sections", []) or []

        problems = []
        if not title:
            problems.append("empty_title")
        elif len(title) > MAX_TITLE_CHARS:
            problems.append(f"title_over_{MAX_TITLE_CHARS}_chars")
        if len(description) > MAX_DESCRIPTION_CHARS:
            problems.append(f"description_over_{MAX_DESCRIPTION_CHARS}_chars")
        if len(sections) < MIN_SECTIONS:
            problems.append("too_few_sections")
        elif not any((getattr(s, "narration", "") or "").strip() for s in sections):
            problems.append("no_narration")

        if video_path is not None:
            path = Path(video_path)
            if not path.exists():
                problems.append("rendered_file_missing")
            elif path.stat().st_size < MIN_VIDEO_BYTES:
                problems.append("rendered_file_too_small")

        target = decision.blocks if config.block_on_sanity else decision.warnings
        target.extend(problems)
    except Exception as e:
        # A broken check is a warning, never a block — see the docstring above.
        decision.warnings.append(f"sanity_check_errored:{type(e).__name__}")


def _check_video_qc(decision: GateDecision, config: GateConfig, video_path, qc_report) -> None:
    """The measured file: streams, duration vs narration, black and silence.

    Part of sanity — a video with no audio track or a ten-second black hole is
    as unpublishable as an empty title — so its severe findings follow
    `block_on_sanity`. What the QC module could not measure arrives in its
    `warnings` and stays a warning here: a broken checker never blocks.
    """
    if qc_report is None:
        if video_path is not None:
            # Unmeasured is not passed: say so, without holding the video.
            decision.warnings.append("video_qc_not_run")
        return
    decision.checks_run.append("video_qc")
    try:
        severe = [str(r) for r in (getattr(qc_report, "blocks", None) or [])]
        advisory = [str(r) for r in (getattr(qc_report, "warnings", None) or [])]
        (decision.blocks if config.block_on_sanity else decision.warnings).extend(severe)
        decision.warnings.extend(advisory)
        to_metadata = getattr(qc_report, "to_metadata", None)
        if callable(to_metadata):
            decision.video_qc = to_metadata()
    except Exception as e:
        decision.warnings.append(f"video_qc_errored:{type(e).__name__}")


def _check_fact_results(decision: GateDecision, config: GateConfig, fact_results) -> None:
    """Claims the fact-checker flagged for a human.

    `fact_checker` sets requires_human_review itself and never takes it from the
    model, so this reads a verdict the model could not talk its way past. The
    count is recorded; the claims themselves are not, so nothing from the script
    reaches the event stream.
    """
    if fact_results is None:
        # A check you configured to block, when it did not run, blocks — a
        # fact-check that never ran is a missing gate, not a passed one, and
        # letting it through silently is exactly the "unknown read as OK" this
        # gate exists to prevent. When block_on_fact_check is off you only
        # wanted a warning anyway, so it stays one.
        (decision.blocks if config.block_on_fact_check else decision.warnings).append(
            "fact_check_not_run"
        )
        return
    decision.checks_run.append("fact_check")
    try:
        flagged = [r for r in fact_results if getattr(r, "requires_human_review", False)]
        if not flagged:
            return
        reason = f"fact_check_flagged:{len(flagged)}"
        (decision.blocks if config.block_on_fact_check else decision.warnings).append(reason)
    except Exception as e:
        # Same reasoning: the check was asked for and could not complete.
        (decision.blocks if config.block_on_fact_check else decision.warnings).append(
            f"fact_check_errored:{type(e).__name__}"
        )


def _check_originality(decision: GateDecision, config: GateConfig, topic: str, originality) -> None:
    """Whether this topic duplicates something the channel already published.

    `originality_engine` has existed for a long time and was never consulted
    before an upload — it was wired into topic *selection* only. Publishing a
    near-duplicate is exactly the pattern that gets a channel flagged for
    reused content, so it belongs here too.
    """
    if not topic:
        # No topic means duplication cannot be checked at all. If the channel
        # is configured to block duplicates, an uncheckable case blocks rather
        # than passing unverified.
        (decision.blocks if config.block_on_duplicate else decision.warnings).append(
            "originality_not_run:no_topic"
        )
        return
    decision.checks_run.append("originality")
    try:
        engine = originality
        if engine is None:
            from modules.originality_engine import OriginalityEngine

            engine = OriginalityEngine()
        result = engine.check(topic)
    except Exception as e:
        # Loading a model can fail on a constrained runner. That is a real risk,
        # but a duplicate check that could not run is not evidence the topic is
        # original — so it inherits block_on_duplicate rather than passing. The
        # safe direction: a blocked video stays private on disk for a human, it
        # is never lost. Set block_on_duplicate off to make this a warning.
        (decision.blocks if config.block_on_duplicate else decision.warnings).append(
            f"originality_errored:{type(e).__name__}"
        )
        return

    if getattr(result, "is_duplicate", False):
        (decision.blocks if config.block_on_duplicate else decision.warnings).append(
            "duplicate_topic"
        )
    elif getattr(result, "needs_review", False):
        decision.warnings.append("near_duplicate_topic")


#: At most this many scene ids are spelled out in a rights reason string; the
#: full lists are in the event metadata.
MAX_REASON_SCENE_IDS = 12

_RIGHTS_OK = "ok"
_RIGHTS_BLOCKED = "blocked"


def _field(obj, name):
    """Read `name` from a VideoProject/Scene/AssetRef or its dict form."""
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _rights_reason(kind: str, count: int, scene_ids: list) -> str:
    """``rights_<kind>:<asset count>:<scene ids>`` — e.g. ``rights_unknown:3:s000,s002``."""
    reason = f"rights_{kind}:{count}"
    if scene_ids:
        shown = scene_ids[:MAX_REASON_SCENE_IDS]
        more = len(scene_ids) - len(shown)
        reason += ":" + ",".join(shown) + (f",+{more}" if more > 0 else "")
    return reason


def _check_rights(decision: GateDecision, config: GateConfig, ir_project) -> None:
    """Whether the footage this video actually uses may be published.

    Reads the run's Video IR (modules/video_ir.py). Only assets referenced by
    some scene's ``asset_ids`` count — an asset that was fetched but never
    placed is not in the video. Per used asset:

    * ``"blocked"`` → block (``block_on_rights``, default on).
    * ``"ok"`` → passes.
    * anything else — ``"unknown"``, a missing status, a scene referencing an
      asset the IR has no record of — is unknown: a warning, and a block only
      when the channel opted into ``block_on_unknown_rights``. Unknown is never
      read as ok.

    No project → ``rights_check_not_run`` warning: unmeasured is not passed,
    but the IR is best-effort, so its absence does not hold the video. A check
    that crashes warns and never blocks, like every other checker here.
    """
    if ir_project is None:
        decision.warnings.append("rights_check_not_run")
        return
    decision.checks_run.append("rights")
    try:
        status_by_asset = {}
        for asset in _field(ir_project, "assets") or ():
            aid = _field(asset, "id")
            if not aid:
                continue
            status = _field(_field(asset, "rights") or {}, "status")
            status_by_asset[str(aid)] = str(status) if status else None

        used = []  # unique asset ids, first-use order
        scenes_by_asset = {}
        for scene in _field(ir_project, "scenes") or ():
            sid = str(_field(scene, "id") or "")
            for aid in _field(scene, "asset_ids") or ():
                aid = str(aid)
                if aid not in scenes_by_asset:
                    scenes_by_asset[aid] = []
                    used.append(aid)
                if sid and sid not in scenes_by_asset[aid]:
                    scenes_by_asset[aid].append(sid)

        ok, unknown, blocked = [], [], []
        for aid in used:
            status = status_by_asset.get(aid)
            if status == _RIGHTS_BLOCKED:
                blocked.append(aid)
            elif status == _RIGHTS_OK:
                ok.append(aid)
            else:
                unknown.append(aid)

        def scenes_of(aids: list) -> list:
            out = []
            for aid in aids:
                for sid in scenes_by_asset.get(aid, ()):
                    if sid not in out:
                        out.append(sid)
            return sorted(out)

        blocked_scenes = scenes_of(blocked)
        unknown_scenes = scenes_of(unknown)
        rights_meta = {
            "assets_used": len(used),
            "ok": len(ok),
            "unknown": len(unknown),
            "blocked": len(blocked),
            "blocked_scene_ids": blocked_scenes,
            "unknown_scene_ids": unknown_scenes,
            "blocked_asset_ids": list(blocked),
            "block_on_unknown": config.block_on_unknown_rights,
        }
    except Exception as e:
        decision.warnings.append(f"rights_check_errored:{type(e).__name__}")
        return

    decision.rights = rights_meta
    if blocked:
        (decision.blocks if config.block_on_rights else decision.warnings).append(
            _rights_reason("blocked", len(blocked), blocked_scenes)
        )
    if unknown:
        (decision.blocks if config.block_on_unknown_rights else decision.warnings).append(
            _rights_reason("unknown", len(unknown), unknown_scenes)
        )
