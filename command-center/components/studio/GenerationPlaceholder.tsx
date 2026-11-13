"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { TriangleAlert } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { isActiveStatus, kindLabel, statusView, type StudioJob } from "@/lib/creative/studio";
import {
  MIN_SAMPLES,
  jobClipSeconds,
  jobPhase,
  progressReading,
  type NoEstimate,
  type ProbeSeed,
  type ProgressReading,
} from "@/lib/creative/progress";
import { DURATION_MODELS_MAX } from "@/lib/creative/durations";
import "@/components/studio/generation-placeholder.css";

/** Is the person's system asking for less motion? Read live, so changing the setting stops the wave at once. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    if (!mq) return;
    setReduced(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/** A one-second clock, running only while `on` (a job still working): a finished placeholder does not tick. */
function useClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

/** The pill's text and the sentence a screen reader hears instead (the sentence says what kind of number it is). */
export function pillWords(
  t: ReturnType<typeof useI18n>["t"],
  fmt: ReturnType<typeof useI18n>["fmt"],
  r: ProgressReading,
): { text: string; spoken: string } | null {
  const tp = t.studioProgress;
  if (r.kind === "estimate") return { text: fmt(tp.estimate, { n: r.percent }), spoken: fmt(tp.estimateSpoken, { n: r.percent, count: r.samples }) };
  if (r.kind === "seeded") {
    // Said apart from the history estimate on the pill itself, not only in the sentence: a test run is not this workspace's jobs.
    const spoken =
      r.scaled && r.probeClip !== null && r.clip !== null
        ? fmt(tp.seededScaledSpoken, { n: r.percent, s: r.probeSeconds, probe: r.probeClip, clip: r.clip })
        : fmt(tp.seededSpoken, { n: r.percent, s: r.probeSeconds });
    return { text: fmt(tp.seeded, { n: r.percent }), spoken };
  }
  if (r.kind === "reported") return { text: fmt(tp.reported, { n: r.percent }), spoken: fmt(tp.reportedSpoken, { n: r.percent }) };
  if (r.kind === "elapsed") {
    const text = r.seconds < 60 ? fmt(tp.seconds, { n: r.seconds }) : fmt(tp.minutes, { m: Math.floor(r.seconds / 60), s: r.seconds % 60 });
    const vars = { n: r.seconds, min: MIN_SAMPLES, max: DURATION_MODELS_MAX };
    if (r.waiting) return { text, spoken: fmt(tp.waitingSpoken, vars) };
    if (r.since === "asked") return { text, spoken: fmt(tp.elapsedNoStartSpoken, vars) };
    const why = r.history === "unread" ? tp.elapsedUnreadSpoken : r.history === "not_asked" ? tp.elapsedNotAskedSpoken : tp.elapsedSpoken;
    return { text, spoken: fmt(why, vars) };
  }
  return null;
}

export type PlaceholderSize = "card" | "stage" | "thumb" | "bar";

/**
 * The result that is coming, drawn where it will appear: a dark frame of dots in the primary colour that brighten
 * in a slow wave from the centre, the job's phase above with a live lamp, and a pill with how far along it is.
 *
 * Everything it says is read from the job's own row, which the feed polls — so a refresh mid-job draws the same
 * thing, and nothing here is kept in the page. The pill is an estimate only when there is something to estimate from
 * (lib/creative/progress.ts) — this workspace's history, or else the platform's test run of the model, marked as one —
 * always with "~"; otherwise it counts seconds. The phase line is the polite live region
 * (a phase change is news); the pill is not, so a screen reader is not read a number every second.
 *
 * `failure`: the reason the feed already gives for a job that ended without a result. `ready`: the job is done but
 * its picture has not been drawn yet (the library read is still on its way).
 */
export function GenerationPlaceholder({
  job,
  samples,
  size = "card",
  failure = null,
  ready = false,
  aspect,
  missing = "unread",
  clockOffset = 0,
  seed = null,
}: {
  /** The result's shape (cardAspect), for the stage, which has no shape of its own to fill. */
  aspect?: string;
  job: Pick<StudioJob, "status" | "capability" | "created_at" | "started_at"> & { params?: StudioJob["params"] };
  /** This model's recent durations here (s); null = none read, and `missing` says why. */
  samples: readonly number[] | null;
  /** The platform's test run of this model (0151): the expected time while `samples` were read and are too few. */
  seed?: ProbeSeed | null;
  missing?: Exclude<NoEstimate, "few">;
  /** The server's clock minus this browser's (ms, lib/creative/progress clockOffset): the row's times are the server's. */
  clockOffset?: number;
  size?: PlaceholderSize;
  failure?: string | null;
  ready?: boolean;
}) {
  const { t, fmt } = useI18n();
  const tp = t.studioProgress;
  const reduced = useReducedMotion();
  const active = isActiveStatus(job.status);
  const now = useClock(active);
  const phase = ready ? "done" : jobPhase(job.status);
  const sv = statusView(t, job.status);
  // No provider reports progress into creative_jobs today (0036 has no column for it), so nothing is passed as
  // `reported`: the pill is the history estimate, the test-run estimate or the seconds, and says which.
  const reading = progressReading({
    status: job.status,
    startedAt: job.started_at,
    createdAt: job.created_at,
    now: now + clockOffset,
    samples,
    missing,
    seed,
    capability: job.capability,
    clipSeconds: jobClipSeconds(job.params),
  });
  const pill = active ? pillWords(t, fmt, reading) : null;
  const failed = !active && !ready;
  const words = ready ? tp.loadingResult : tp.phase[phase];
  const state = failed ? "failed" : ready ? "ready" : "active";

  return (
    <div
      className="gen-ph"
      data-size={size}
      data-state={state}
      data-phase={phase}
      data-motion={active && !reduced ? "wave" : "still"}
      data-testid="gen-placeholder"
      data-shaped={aspect ? "true" : undefined}
      // `--gen-ar` (e.g. "9 / 16") lets the stylesheet take the width from the height cap, so a tall shape stays tall.
      style={aspect ? ({ aspectRatio: aspect, "--gen-ar": aspect } as CSSProperties) : undefined}
    >
      <span aria-hidden className="gen-ph-dots" />
      <span aria-hidden className="gen-ph-wave" />
      {size === "thumb" ? (
        <span className="gen-ph-center">
          {failed ? (
            <TriangleAlert aria-hidden className="size-4" strokeWidth={1.75} />
          ) : (
            <span aria-hidden className="ns-lamp" data-tone={sv.tone} data-live={sv.live ? "true" : undefined} />
          )}
          <span className="sr-only">{failed ? sv.label : words}</span>
        </span>
      ) : (
        <>
          <span className="sr-only">{fmt(tp.coming, { kind: kindLabel(t, job.capability) })}</span>
          {!failed && (
            <p className="gen-ph-status" aria-live="polite" data-testid="gen-phase">
              <span aria-hidden className="ns-lamp" data-tone={ready ? "ok" : sv.tone} data-live={sv.live ? "true" : undefined} />
              <span>{words}</span>
            </p>
          )}
          {failed && (
            <span className="gen-ph-failure">
              <TriangleAlert aria-hidden className="size-5 shrink-0" strokeWidth={1.75} />
              {failure ? <span data-testid="gen-failure">{failure}</span> : <span>{sv.label}</span>}
            </span>
          )}
          {pill && (
            <span className="gen-ph-pill tnum" data-kind={reading.kind} data-testid="gen-pill">
              {/* The sentence is shown on hover too, so the reason is not only for a screen reader; on the hidden
                  half, so a screen reader does not hear it twice. */}
              <span aria-hidden title={pill.spoken}>
                {pill.text}
              </span>
              <span className="sr-only">{pill.spoken}</span>
            </span>
          )}
        </>
      )}
    </div>
  );
}
