/**
 * Experiments — one shape over the two A/B tests the pipeline already runs.
 * Mirrors modules/experiments.py. Built FROM the existing results in
 * lib/measurement.ts (variantPerformance / hookPerformance), so the verdict
 * shown is the same one those functions — and the pipeline — reach; this only
 * adds the explicit status and the per-arm progress toward the minimum sample.
 *
 *   running      — fewer than two arms have MIN_PER_VARIANT measured videos
 *   inconclusive — enough samples, but under MIN_LIFT (or an arm measured 0):
 *                  a tie, never a guessed winner
 *   decided      — the existing rule named a winner
 */

import { MIN_LIFT, MIN_PER_VARIANT, type ABResult, type HookResult } from "@/lib/measurement";

export type ExperimentStatus = "running" | "inconclusive" | "decided";
export type ExperimentKind = "thumbnail_title" | "hook";

export interface ExperimentVariant {
  label: string;
  /** Measured videos on this arm — an unmeasured video is not a sample. */
  samples: number;
  /** Mean of the metric over those videos, null when none were measured. */
  value: number | null;
}

export interface Experiment {
  kind: ExperimentKind;
  metric: "impression_ctr" | "average_view_duration_seconds";
  variants: ExperimentVariant[];
  minSample: number;
  minLift: number;
  samples: number;
  status: ExperimentStatus;
  winner: string | null;
  /** Leader over runner-up among arms at the minimum sample; null while running. */
  effect: number | null;
}

function ready(variants: ExperimentVariant[]): ExperimentVariant[] {
  return variants.filter((v) => v.samples >= MIN_PER_VARIANT && v.value !== null);
}

export function experimentStatus(variants: ExperimentVariant[], winner: string | null): ExperimentStatus {
  if (winner !== null) return "decided";
  return ready(variants).length < 2 ? "running" : "inconclusive";
}

export function experimentEffect(variants: ExperimentVariant[]): number | null {
  const values = ready(variants)
    .map((v) => v.value as number)
    .sort((a, b) => b - a);
  if (values.length < 2 || values[1] <= 0) return null;
  return (values[0] - values[1]) / values[1];
}

function build(
  kind: ExperimentKind,
  metric: Experiment["metric"],
  variants: ExperimentVariant[],
  winner: string | null,
): Experiment {
  const status = experimentStatus(variants, winner);
  return {
    kind,
    metric,
    // Stable A, B, C… order so the progress line does not reshuffle once decided.
    variants: [...variants].sort((a, b) => a.label.localeCompare(b.label)),
    minSample: MIN_PER_VARIANT,
    minLift: MIN_LIFT,
    samples: variants.reduce((sum, v) => sum + v.samples, 0),
    status,
    winner,
    effect: status === "running" ? null : experimentEffect(variants),
  };
}

export function thumbnailExperiment(ab: ABResult): Experiment {
  return build(
    "thumbnail_title",
    "impression_ctr",
    ab.arms.map((s) => ({ label: s.variant, samples: s.videos, value: s.meanCtr })),
    ab.winner,
  );
}

export function hookExperiment(hook: HookResult): Experiment {
  return build(
    "hook",
    "average_view_duration_seconds",
    [hook.a, hook.b].map((s) => ({ label: s.variant, samples: s.videos, value: s.meanRetention })),
    hook.winner,
  );
}
