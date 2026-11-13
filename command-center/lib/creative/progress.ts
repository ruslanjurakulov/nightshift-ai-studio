/**
 * The generation placeholder's arithmetic (components/studio/GenerationPlaceholder): which phase a job is in, what
 * shape to hold for its result, and what number — if any — the pill may show. Pure, so the rules that keep a guess
 * from passing for a measurement are pinned in tests/studio-progress.test.ts.
 *
 * The number is the delicate part (CLAUDE.md #5). No provider writes progress into creative_jobs: 0036 has no such
 * column and modules/creative_worker.py records only the phase. So a percentage is an ESTIMATE from this
 * organization's own finished jobs on the same model — the time since this one started over the median time those
 * took — always printed with "~" and capped below 100 until the database says the job is done. With too little
 * history the expected time is the platform's own test run of the model (migration 0151's probe seed), said as such
 * on the pill and only for the capability that was tested; without that either, only the seconds since it started.
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
 * Why a started job's pill counts seconds instead of estimating — each is a different sentence, because "this model
 * has too little history here" is a claim about the data, and it is false when the data simply was not read:
 * - `few`: the history was read and has fewer than MIN_SAMPLES usable durations;
 * - `unread`: it was asked for and has not arrived (still on its way, a failed request, a 503, a failed read);
 * - `not_asked`: it was never asked for (more models were working at once than one request may name).
 */
export type NoEstimate = "few" | "unread" | "not_asked";

/**
 * A probe older than this seeds nothing. Probes are run by hand (.github/workflows/probe_models.yml has no schedule), and a
 * vendor's queue times and model versions move: a month is the longest a single test call is taken to describe the model's
 * speed today. Past it the pill counts seconds again until the owner re-probes or this organization has its own history.
 */
export const PROBE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A probe time stamped further in the future than this is a clock or a row not to believe, not a fresh probe. */
export const PROBE_FUTURE_SLACK_MS = 60 * 1000;
/** The capabilities whose length is asked for in seconds (params.duration_s): the only ones a probe's time is scaled for. */
export const CLIP_CAPABILITIES: readonly string[] = ["t2v", "i2v"];
/** A clip length beyond this is not one any model makes; the same bound 0151 puts on the probe block's. */
const CLIP_MAX_S = 3600;

/**
 * The platform's own test run of a model (0151 model_probe_seconds): the newest successful probe's wall time — submit to the
 * downloaded file, so it INCLUDES the download and the probe tool's poll interval — the capability it tested, the clip
 * length the probe asked for (null when it named none), when it ran, and whether a probe of that capability failed since.
 */
export interface ProbeSeed {
  capability: string;
  seconds: number;
  clipSeconds: number | null;
  probedAt: string;
  failedAfter: boolean;
}

const CAPABILITY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const isSeconds = (x: unknown, max: number): x is number => typeof x === "number" && Number.isFinite(x) && x > 0 && x <= max;

/** One seed from its fields; null when any is unreadable — a seed is used whole or not at all, never patched with a guess. */
function seedOf(capability: unknown, seconds: unknown, clip: unknown, probedAt: unknown, failedAfter: unknown): ProbeSeed | null {
  if (typeof capability !== "string" || !CAPABILITY_RE.test(capability)) return null;
  if (!isSeconds(seconds, SAMPLE_MAX_S)) return null;
  if (typeof probedAt !== "string" || !Number.isFinite(Date.parse(probedAt))) return null;
  // "Did it fail since?" unanswered is not "no": without a clear false there is no seed.
  if (typeof failedAfter !== "boolean") return null;
  return { capability, seconds, clipSeconds: isSeconds(clip, CLIP_MAX_S) ? clip : null, probedAt, failedAfter };
}

/** 0151's rows (model_id, capability, probe_seconds, clip_seconds, probed_at, failed_after) → seeds of the models asked about. */
export function seedsFrom(rows: unknown, asked: readonly string[]): Record<string, ProbeSeed> {
  const out: Record<string, ProbeSeed> = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const x = r as Record<string, unknown>;
    if (typeof x.model_id !== "string" || !asked.includes(x.model_id)) continue;
    const seed = seedOf(x.capability, x.probe_seconds, x.clip_seconds, x.probed_at, x.failed_after);
    if (seed) out[x.model_id] = seed;
  }
  return out;
}

/** A seed as the durations route sends it, read again in the browser (anything else in the body is ignored). */
export function coerceProbeSeed(x: unknown): ProbeSeed | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const s = x as Record<string, unknown>;
  return seedOf(s.capability, s.seconds, s.clipSeconds, s.probedAt, s.failedAfter);
}

/** The clip length a job asked for (params.duration_s), or null when it named none readable. */
export function jobClipSeconds(params: Record<string, unknown> | null | undefined): number | null {
  const d = params?.duration_s;
  return isSeconds(d, CLIP_MAX_S) ? d : null;
}

/**
 * How long a job is expected to take from a probe seed, or null when the seed may not stand in for one: none, a failure
 * since, another capability than the one tested (an i2v probe says nothing about t2v), older than PROBE_MAX_AGE_MS or
 * from the future, or unreadable.
 *
 * ASSUMPTION, not a measurement: for a video, time is taken to grow in proportion to the clip's length — a 10 s clip
 * twice a 5 s probe's time. Real jobs carry a fixed part (the queue, the upload of the first frame, the download) that
 * does not grow, so this over-expects long clips. It is only ever an estimate, printed with "~" and capped, and it gives
 * way to the organization's own median as soon as there are MIN_SAMPLES finished jobs. Scaled only when both lengths are
 * known; otherwise the probe's time as it is.
 */
export function seedExpectation(
  seed: ProbeSeed | null | undefined,
  job: { capability: string; clipSeconds: number | null | undefined },
  now: number,
): { seconds: number; scaled: boolean } | null {
  if (!seed || seed.failedAfter !== false) return null;
  if (!isSeconds(seed.seconds, SAMPLE_MAX_S) || seed.capability !== job.capability) return null;
  const at = Date.parse(seed.probedAt);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return null;
  const age = now - at;
  if (age > PROBE_MAX_AGE_MS || age < -PROBE_FUTURE_SLACK_MS) return null;
  const clip = job.clipSeconds;
  const probeClip = seed.clipSeconds;
  if (CLIP_CAPABILITIES.includes(job.capability) && isSeconds(clip, CLIP_MAX_S) && isSeconds(probeClip, CLIP_MAX_S) && clip !== probeClip) {
    return { seconds: (seed.seconds * clip) / probeClip, scaled: true };
  }
  return { seconds: seed.seconds, scaled: false };
}

/** The probe's seconds as said: tenths below 10 s (a 0.9 s picture is not "1 s" or "0 s"), whole seconds above. */
function saidSeconds(s: number): number {
  return s < 10 ? Math.round(s * 10) / 10 : Math.round(s);
}

/**
 * What the pill may say.
 * - `reported`: a number the provider itself reported (none does today; see the file's head) — printed without "~".
 * - `estimate`: ~N% from this organization's history on the model, N ≤ ESTIMATE_CAP.
 * - `seeded`: ~N% from the platform's test run of the model (ProbeSeed), N ≤ ESTIMATE_CAP, when the history here was read
 *   and is too short. `probeSeconds` is the test run's time as said; `scaled` when it was scaled from the probe's clip
 *   length (`probeClip`) to this job's (`clip`).
 * - `elapsed`: seconds. `since` says from what: the job's start (`started`), or when it was asked for (`asked`) — in
 *   line (`waiting`), or started without a recorded start time. `history` says why there is no estimate; null when
 *   none was looked for (counting from the ask, there is no "since it started" to set against a median).
 * - `none`: nothing can be read, so nothing is printed.
 */
export type ProgressReading =
  | { kind: "reported"; percent: number }
  | { kind: "estimate"; percent: number; samples: number }
  | { kind: "seeded"; percent: number; probeSeconds: number; scaled: boolean; probeClip: number | null; clip: number | null }
  | { kind: "elapsed"; seconds: number; waiting: boolean; since: "started" | "asked"; history: NoEstimate | null }
  | { kind: "none" };

export function progressReading({
  status,
  startedAt,
  createdAt,
  now,
  samples,
  missing = "unread",
  reported = null,
  seed = null,
  capability = "",
  clipSeconds = null,
}: {
  status: string;
  startedAt: string | null | undefined;
  createdAt: string | null | undefined;
  /** The server's "now" (the browser's clock corrected by clockOffset), since the row's times are the server's. */
  now: number;
  /** Durations (s) of the model's newest finished jobs here; null = none read (`missing` says why). */
  samples: readonly number[] | null;
  /** Why `samples` is null: asked and not (yet) read, or never asked. */
  missing?: Exclude<NoEstimate, "few">;
  /** A fraction 0..1 the provider reported for THIS job, when one ever does. */
  reported?: number | null;
  /** The platform's test run of the model (0151), used only while `samples` were read and are too few. */
  seed?: ProbeSeed | null;
  /** The job's capability and the clip length it asked for: a seed stands in only for the capability it tested. */
  capability?: string;
  clipSeconds?: number | null;
}): ProgressReading {
  if (!isActiveStatus(status)) return { kind: "none" };
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0 && reported <= 1) {
    return { kind: "reported", percent: Math.floor(reported * 100) };
  }
  // In line, the model has not been asked yet: the history of how long the model takes says nothing about the queue.
  const ran = status === "queued" ? null : secondsBetween(startedAt, now);
  if (ran === null) {
    const waited = secondsBetween(createdAt, now);
    return waited === null ? { kind: "none" } : { kind: "elapsed", seconds: waited, waiting: status === "queued", since: "asked", history: null };
  }
  if (samples === null) return { kind: "elapsed", seconds: ran, waiting: false, since: "started", history: missing };
  const valid = samples.filter((x) => Number.isFinite(x) && x > 0);
  const m = valid.length >= MIN_SAMPLES ? median(valid) : null;
  if (m === null) {
    // History unread is never seeded (the branch above): "too few jobs here" is then a claim nobody checked, and the org
    // may well have its own median waiting. Read and short, the test run stands in until there are MIN_SAMPLES.
    const expected = seedExpectation(seed, { capability, clipSeconds }, now);
    if (expected === null) return { kind: "elapsed", seconds: ran, waiting: false, since: "started", history: "few" };
    return {
      kind: "seeded",
      percent: Math.min(ESTIMATE_CAP, Math.floor((ran / expected.seconds) * 100)),
      probeSeconds: saidSeconds(seed!.seconds),
      scaled: expected.scaled,
      probeClip: expected.scaled ? seed!.clipSeconds : null,
      clip: expected.scaled ? (clipSeconds ?? null) : null,
    };
  }
  return { kind: "estimate", percent: Math.min(ESTIMATE_CAP, Math.floor((ran / m) * 100)), samples: valid.length };
}

/** The Date header counts whole seconds and the answer took a trip: a difference this small is that, not a wrong clock. */
export const CLOCK_SLACK_MS = 2000;
/** A difference larger than this is not a clock to correct for but a header not to believe (a cached answer, a bad proxy). */
export const CLOCK_OFFSET_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * How far the server's clock is ahead of this browser's (ms; negative = behind), from the Date header of an answer
 * and the browser's time when it arrived. The row's started_at / created_at are the database's clock, so a browser
 * set a minute fast would otherwise show every job a minute older than it is (and an estimate that much further on).
 * 0 when the header is missing or unreadable, or the difference is within the header's own rounding; never more than
 * CLOCK_OFFSET_MAX_MS either way (beyond that the header, not the clock, is what is wrong: 0).
 */
export function clockOffset(dateHeader: string | null | undefined, receivedAt: number): number {
  if (typeof dateHeader !== "string" || !Number.isFinite(receivedAt)) return 0;
  const server = Date.parse(dateHeader);
  if (!Number.isFinite(server)) return 0;
  // The header is the second the server wrote it, floored: its middle is the better guess at the server's "now".
  const offset = server + 500 - receivedAt;
  if (Math.abs(offset) <= CLOCK_SLACK_MS || Math.abs(offset) > CLOCK_OFFSET_MAX_MS) return 0;
  return Math.round(offset);
}

/**
 * The offset to keep, given the one in use and a new reading: a reading within CLOCK_SLACK_MS of the one in use is
 * the header's rounding again, and taking it would make the seconds on every pill jump back and forth on each poll.
 */
export function nextClockOffset(current: number, reading: number): number {
  return Math.abs(reading - current) <= CLOCK_SLACK_MS ? current : reading;
}
