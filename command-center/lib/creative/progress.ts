/**
 * The generation placeholder's arithmetic (components/studio/GenerationPlaceholder): which phase a job is in, what
 * shape to hold for its result, and what number — if any — the pill may show. Pure, so the rules that keep a guess
 * from passing for a measurement are pinned in tests/studio-progress.test.ts.
 *
 * The number is the delicate part (CLAUDE.md #5). No provider writes progress into creative_jobs: 0036 has no such
 * column and modules/creative_worker.py records only the phase. So a percentage is an ESTIMATE from this
 * organization's own finished jobs on the same model — the time since this one started over the median time those
 * took — always printed with "~" and capped below 100 until the database says the job is done. With too little
 * history there is no percentage at all, only the seconds since it started.
 */
import { isActiveStatus } from "@/lib/creative/studio";

/** How many of a model's newest finished jobs the median is taken over. */
export const DURATION_SAMPLES = 20;
/** Fewer finished jobs than this and a median says too little: the pill shows seconds instead. */
export const MIN_SAMPLES = 3;
/** An estimate never reaches 100: only the job's own "completed" row may say it is done. */
export const ESTIMATE_CAP = 95;
/** A sample longer than a job may live (0036's two-hour expiry) is a broken row, not a duration. */
export const SAMPLE_MAX_S = 2 * 60 * 60;

/**
 * What the job is doing, from its status alone (0036's lifecycle, set only by the worker):
 * queued → running (claimed, being sent to the model) → provider_pending (the model has it) →
 * processing (the files are being stored) → completed | failed | cancelled | expired.
 * 'planning' and 'rendering' are reserved for agent and render jobs and read as the model working.
 */
export type JobPhase = "queued" | "sending" | "making" | "storing" | "done" | "failed";

export function jobPhase(status: string): JobPhase {
  if (status === "queued") return "queued";
  if (status === "running") return "sending";
  if (status === "processing") return "storing";
  if (status === "completed") return "done";
  if (isActiveStatus(status)) return "making";
  return "failed";
}

/** The median of the readable, positive samples; null when there are none. */
export function median(samples: readonly number[]): number | null {
  const xs = samples.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

/** Seconds from one ISO time to another, or null when either cannot be read (never a made-up 0). */
export function secondsBetween(fromIso: unknown, toMs: number): number | null {
  if (typeof fromIso !== "string") return null;
  const at = Date.parse(fromIso);
  if (!Number.isFinite(at) || !Number.isFinite(toMs)) return null;
  return Math.max(0, Math.floor((toMs - at) / 1000));
}

/**
 * Finished jobs' rows → their durations in seconds (started_at → finished_at). A row without both times, with the
 * end before the start, or longer than a job may live is left out rather than counted as something.
 */
export function durationsFrom(rows: unknown): number[] {
  if (!Array.isArray(rows)) return [];
  const out: number[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const { started_at, finished_at } = r as Record<string, unknown>;
    if (typeof started_at !== "string" || typeof finished_at !== "string") continue;
    const s = Date.parse(started_at);
    const f = Date.parse(finished_at);
    if (!Number.isFinite(s) || !Number.isFinite(f)) continue;
    const d = (f - s) / 1000;
    if (d > 0 && d <= SAMPLE_MAX_S) out.push(d);
  }
  return out.slice(0, DURATION_SAMPLES);
}

/**
 * What the pill may say.
 * - `reported`: a number the provider itself reported (none does today; see the file's head) — printed without "~".
 * - `estimate`: ~N% from this organization's history on the model, N ≤ ESTIMATE_CAP.
 * - `elapsed`: seconds — since it started, or (`waiting`) since it was asked for while it is still in line.
 * - `none`: nothing can be read, so nothing is printed.
 */
export type ProgressReading =
  | { kind: "reported"; percent: number }
  | { kind: "estimate"; percent: number; samples: number }
  | { kind: "elapsed"; seconds: number; waiting: boolean }
  | { kind: "none" };

export function progressReading({
  status,
  startedAt,
  createdAt,
  now,
  samples,
  reported = null,
}: {
  status: string;
  startedAt: string | null | undefined;
  createdAt: string | null | undefined;
  now: number;
  /** Durations (s) of the model's newest finished jobs here; null = not read (or unreadable). */
  samples: readonly number[] | null;
  /** A fraction 0..1 the provider reported for THIS job, when one ever does. */
  reported?: number | null;
}): ProgressReading {
  if (!isActiveStatus(status)) return { kind: "none" };
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0 && reported <= 1) {
    return { kind: "reported", percent: Math.floor(reported * 100) };
  }
  // In line, the model has not been asked yet: the history of how long the model takes says nothing about the queue.
  const ran = status === "queued" ? null : secondsBetween(startedAt, now);
  if (ran === null) {
    const waited = secondsBetween(createdAt, now);
    return waited === null ? { kind: "none" } : { kind: "elapsed", seconds: waited, waiting: status === "queued" };
  }
  const valid = (samples ?? []).filter((x) => Number.isFinite(x) && x > 0);
  const m = valid.length >= MIN_SAMPLES ? median(valid) : null;
  if (m === null) return { kind: "elapsed", seconds: ran, waiting: false };
  return { kind: "estimate", percent: Math.min(ESTIMATE_CAP, Math.floor((ran / m) * 100)), samples: valid.length };
}
