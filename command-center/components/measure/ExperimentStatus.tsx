import { StatusPill } from "@/components/ui";
import { fmt, type Dictionary } from "@/lib/i18n";
import type { Experiment } from "@/lib/experiments";

function pct(value: number | null): string | null {
  return value === null ? null : `${(value * 100).toFixed(0)}%`;
}

/**
 * The experiment readout under an existing A/B panel: explicit status
 * (running / inconclusive / decided), the hypothesis and metric, the rules,
 * and each arm's progress toward the minimum sample. Replaces the old
 * "winning / no verdict" pill, which could not tell "still collecting" from
 * "enough data, and it is a tie".
 */
export function ExperimentStatus({ exp, reason, t }: { exp: Experiment; reason: string; t: Dictionary }) {
  const tone = exp.status === "decided" ? "ok" : exp.status === "inconclusive" ? "warn" : "idle";
  const label =
    exp.status === "decided"
      ? fmt(t.measure.expStatusDecided, { variant: exp.winner ?? "" })
      : exp.status === "inconclusive"
        ? t.measure.expStatusInconclusive
        : t.measure.expStatusRunning;
  const effect = pct(exp.effect);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill tone={tone} label={label} />
        <span className="text-xs text-[var(--color-muted)]">{reason}</span>
      </div>
      <p className="m-0 text-xs text-[var(--color-muted)]">
        {exp.kind === "hook" ? t.measure.expHypothesisHook : t.measure.expHypothesisThumb}
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mono text-[11px] text-[var(--color-muted)]">
        {/* The metric is a schema identifier, so it is not translated. */}
        <span>
          {t.measure.expMetric}: {exp.metric}
        </span>
        <span>
          {t.measure.expProgress}:{" "}
          {exp.variants.map((v) => `${v.label} ${v.samples}/${exp.minSample}`).join(" · ")}
        </span>
        <span>
          {t.measure.expEffect}: {effect ?? t.measure.expEffectNone}
        </span>
      </div>
      <p className="m-0 mono text-[10px] text-[var(--color-muted)]">
        {fmt(t.measure.expRules, { n: exp.minSample, lift: pct(exp.minLift) ?? "" })}
      </p>
    </div>
  );
}
