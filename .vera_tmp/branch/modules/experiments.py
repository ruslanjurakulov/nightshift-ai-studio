"""Experiments — one read-side view over the A/B tests the pipeline already runs.

Two experiments exist today, each in its own module and each judged on its own
lever:

* ``ab_testing``  — thumbnail/title arm, judged on impression CTR;
* ``hook_ab``     — the first-30-seconds opening, judged on retention
  (average view duration).

This module does not add a third, does not add tracking and does not change how
a variant is chosen — ``main.py`` keeps calling ``choose_variant_n`` /
``choose_hook`` exactly as before. It only presents both results as the same
shape, ``Experiment``, computed by the modules' own ``variant_performance_n`` /
``hook_performance`` from the rows they already record (``videos.*_variant`` +
``metrics_snapshots``), so the verdict here can never disagree with the verdict
the pipeline acts on.

Status, with explicit rules (the modules' own constants, not new ones):

* ``running``      — fewer than two arms have ``MIN_PER_VARIANT`` measured
  videos. Still collecting; no winner, no effect claimed.
* ``inconclusive`` — enough samples, but the leader beats the runner-up by less
  than ``MIN_LIFT`` (or an arm measured zero). A tie is reported as a tie,
  never as a guessed winner.
* ``decided``      — the underlying module named a winner.

A video with no measured metric is not a sample (unknown, never zero), exactly
as in the underlying modules.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional

from modules.ab_testing import MIN_LIFT, MIN_PER_VARIANT, variant_performance_n
from modules.hook_ab import RETENTION_FIELD, hook_performance

logger = logging.getLogger(__name__)

STATUS_RUNNING = "running"
STATUS_INCONCLUSIVE = "inconclusive"
STATUS_DECIDED = "decided"

KIND_THUMBNAIL = "thumbnail_title"
KIND_HOOK = "hook"

METRIC_CTR = "impression_ctr"
METRIC_RETENTION = RETENTION_FIELD

_THUMBNAIL_LABELS = ("A", "B", "C", "D")


@dataclass(frozen=True)
class Variant:
    label: str
    #: Measured videos on this arm (a video with no metric is not counted).
    samples: int
    #: Mean of the experiment's metric over those videos, None when unmeasured.
    value: Optional[float]


@dataclass(frozen=True)
class Experiment:
    id: str
    kind: str
    hypothesis: str
    metric: str
    variants: tuple
    #: Measured videos each arm needs before it takes part in a verdict.
    min_sample: int
    #: Measured videos across all arms.
    samples: int
    status: str
    winner: Optional[str]
    #: Relative lift of the leader over the runner-up among arms that reached
    #: min_sample; None while running (no effect is claimed from thin data).
    effect: Optional[float]
    evidence: dict = field(default_factory=dict)

    @property
    def decided(self) -> bool:
        return self.status == STATUS_DECIDED and self.winner is not None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "hypothesis": self.hypothesis,
            "metric": self.metric,
            "variants": [
                {"label": v.label, "samples": v.samples, "value": v.value} for v in self.variants
            ],
            "min_sample": self.min_sample,
            "samples": self.samples,
            "status": self.status,
            "winner": self.winner,
            "effect": self.effect,
            "evidence": dict(self.evidence),
        }


def _lift(variants) -> Optional[float]:
    """Leader over runner-up among arms that reached MIN_PER_VARIANT with a
    measured value; None when fewer than two qualify or the runner-up is <= 0."""
    ready = sorted(
        (v.value for v in variants if v.samples >= MIN_PER_VARIANT and v.value is not None),
        reverse=True,
    )
    if len(ready) < 2 or ready[1] <= 0:
        return None
    return round((ready[0] - ready[1]) / ready[1], 4)


def _status(variants, winner) -> str:
    ready = [v for v in variants if v.samples >= MIN_PER_VARIANT and v.value is not None]
    if winner is not None:
        return STATUS_DECIDED
    if len(ready) < 2:
        return STATUS_RUNNING
    return STATUS_INCONCLUSIVE


def _rules() -> dict:
    return {"min_per_variant": MIN_PER_VARIANT, "min_lift": MIN_LIFT}


def thumbnail_experiment(videos, snapshots, arms=("A", "B"), channel_id: Optional[str] = None) -> Experiment:
    """The thumbnail/title experiment as an Experiment, via ab_testing's own
    `variant_performance_n` (so the verdict is the one the pipeline uses)."""
    result = variant_performance_n(videos, snapshots, arms)
    variants = tuple(
        Variant(label=s.variant, samples=s.videos, value=s.mean_ctr) for s in result.stats.values()
    )
    status = _status(variants, result.winner)
    return Experiment(
        id=f"{channel_id or 'all'}:{KIND_THUMBNAIL}",
        kind=KIND_THUMBNAIL,
        hypothesis="One thumbnail/title arm earns a higher click-through rate than the others.",
        metric=METRIC_CTR,
        variants=variants,
        min_sample=MIN_PER_VARIANT,
        samples=sum(v.samples for v in variants),
        status=status,
        winner=result.winner,
        effect=None if status == STATUS_RUNNING else _lift(variants),
        evidence={
            "source": "ab_testing.variant_performance_n",
            "reason": result.reason,
            "rules": _rules(),
            "impressions": {s.variant: s.impressions for s in result.stats.values()},
        },
    )


def hook_experiment(videos, snapshots, channel_id: Optional[str] = None) -> Experiment:
    """The first-30-seconds hook experiment as an Experiment, via hook_ab's own
    `hook_performance`."""
    result = hook_performance(videos, snapshots)
    variants = tuple(
        Variant(label=s.variant, samples=s.videos, value=s.mean_retention_seconds)
        for s in (result.a, result.b)
    )
    status = _status(variants, result.winner)
    return Experiment(
        id=f"{channel_id or 'all'}:{KIND_HOOK}",
        kind=KIND_HOOK,
        hypothesis="The alternate opening (B) holds viewers longer than the primary opening (A), or the reverse.",
        metric=METRIC_RETENTION,
        variants=variants,
        min_sample=MIN_PER_VARIANT,
        samples=sum(v.samples for v in variants),
        status=status,
        winner=result.winner,
        effect=None if status == STATUS_RUNNING else _lift(variants),
        evidence={
            "source": "hook_ab.hook_performance",
            "reason": result.reason,
            "rules": _rules(),
        },
    )


def list_experiments(videos, snapshots, arms=("A", "B"), channel_id: Optional[str] = None) -> list:
    """Both experiments, from already-loaded rows. Pure."""
    return [
        thumbnail_experiment(videos, snapshots, arms, channel_id=channel_id),
        hook_experiment(videos, snapshots, channel_id=channel_id),
    ]


def _configured_arms() -> tuple:
    """The same thumbnail arms main.py experiments across (THUMBNAIL_VARIANT_COUNT)."""
    try:
        import config

        n = int(getattr(config, "THUMBNAIL_VARIANT_COUNT", 2))
    except Exception:
        n = 2
    return _THUMBNAIL_LABELS[: max(2, min(len(_THUMBNAIL_LABELS), n))]


def experiments_for_channel(channel_id: Optional[str], store=None) -> list:
    """Read one channel's rows from the state store and return its experiments.
    Read-only; [] on any failure — an experiment readout never stops a run."""
    try:
        if store is None:
            from modules.state_store import StateStore

            with StateStore() as own:
                return experiments_for_channel(channel_id, store=own)
        videos = store.list_videos(limit=100000, channel_id=channel_id)
        snapshots = [
            m for v in videos if (m := store.latest_metrics(v.get("video_id", ""))) is not None
        ]
        return list_experiments(videos, snapshots, _configured_arms(), channel_id=channel_id)
    except Exception:
        logger.warning("experiments: readout failed for %s", channel_id, exc_info=True)
        return []
