/**
 * The generation placeholder's arithmetic (lib/creative/progress.ts) and its history read (lib/creative/durations.ts).
 *
 * The rule these pin (CLAUDE.md #5): a percentage is shown only when it is backed — by a figure the provider reported,
 * or by the median of at least 3 of this organization's finished jobs on the same model — and an estimate is always
 * marked as one and never reaches 100 before the job's own row says it is done. Without history: seconds, not a %.
 */
import { describe, expect, it } from "vitest";
import {
  CLOCK_OFFSET_MAX_MS,
  DURATION_SAMPLES,
  ESTIMATE_CAP,
  MIN_SAMPLES,
  durationsFrom,
  jobPhase,
  median,
  nextClockOffset,
  clockOffset,
  progressReading,
  secondsBetween,
} from "@/lib/creative/progress";
import { DURATION_MODELS_MAX, listDurations, parseModelList } from "@/lib/creative/durations";
import { cardAspect, cardShape, coerceJobs } from "@/lib/creative/studio";
import type { CreativeDb, DbAnswer } from "@/lib/creative/operations";

const T0 = Date.parse("2026-11-01T10:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const running = (over: Partial<Parameters<typeof progressReading>[0]> = {}) =>
  progressReading({ status: "provider_pending", startedAt: at(0), createdAt: at(-5), now: T0 + 30_000, samples: [60, 60, 60], ...over });

describe("the median", () => {
  it("of an odd and an even count, ignoring order", () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 30, 20])).toBe(25);
  });
  it("ignores unreadable and non-positive samples, and is null when nothing is left", () => {
    expect(median([Number.NaN, -3, 0, 12])).toBe(12);
    expect(median([])).toBeNull();
    expect(median([Number.NaN, 0])).toBeNull();
  });
});

describe("the pill's reading", () => {
  it("is an estimate from the median of the model's history: elapsed since started_at over the median", () => {
    expect(running({ samples: [50, 60, 70] })).toEqual({ kind: "estimate", percent: 50, samples: 3 });
    // The median, not the mean: one very slow job does not drag every estimate down.
    expect(running({ samples: [60, 60, 600] })).toEqual({ kind: "estimate", percent: 50, samples: 3 });
  });

  it("is capped at 95 until the row itself says completed, however long it runs past the median", () => {
    expect(ESTIMATE_CAP).toBe(95);
    expect(running({ now: T0 + 600_000 })).toMatchObject({ kind: "estimate", percent: 95 });
    expect(running({ now: T0 + 57_600 })).toMatchObject({ kind: "estimate", percent: 95 });
  });

  const elapsed = (seconds: number, since: "started" | "asked", history: string | null, waiting = false) => ({
    kind: "elapsed",
    seconds,
    waiting,
    since,
    history,
  });

  it("with fewer than 3 finished jobs for the model: seconds since it started, never a percentage — and says 'few'", () => {
    expect(MIN_SAMPLES).toBe(3);
    expect(running({ samples: [60, 60] })).toEqual(elapsed(30, "started", "few"));
    expect(running({ samples: [] })).toEqual(elapsed(30, "started", "few"));
    // Three samples of which only two are readable are two samples.
    expect(running({ samples: [60, 60, Number.NaN] })).toEqual(elapsed(30, "started", "few"));
  });

  it("history that was not read is not 'too little history': it says why there is none (rule 5)", () => {
    // Asked and not (yet) answered — on its way, a failed fetch, a 503, a failed read of that model.
    expect(running({ samples: null })).toEqual(elapsed(30, "started", "unread"));
    expect(running({ samples: null, missing: "unread" })).toEqual(elapsed(30, "started", "unread"));
    // Never asked: past DURATION_MODELS_MAX models at once.
    expect(running({ samples: null, missing: "not_asked" })).toEqual(elapsed(30, "started", "not_asked"));
    // A reason for missing samples never outranks samples that were read.
    expect(running({ samples: [60, 60], missing: "not_asked" })).toEqual(elapsed(30, "started", "few"));
    expect(running({ samples: [50, 60, 70], missing: "not_asked" }).kind).toBe("estimate");
  });

  it("prefers a figure the provider reported, printed as it is (no '~', no cap)", () => {
    expect(running({ reported: 0.42 })).toEqual({ kind: "reported", percent: 42 });
    expect(running({ reported: 0.42, samples: null })).toEqual({ kind: "reported", percent: 42 });
    expect(running({ reported: 0.99 })).toEqual({ kind: "reported", percent: 99 });
    // A figure that cannot be a fraction is not reported progress: back to the history.
    expect(running({ reported: 4.2 }).kind).toBe("estimate");
    expect(running({ reported: Number.NaN }).kind).toBe("estimate");
  });

  it("a job in line counts its wait since it was asked for — the model's history says nothing about the queue", () => {
    expect(progressReading({ status: "queued", startedAt: null, createdAt: at(0), now: T0 + 12_000, samples: [5, 5, 5] })).toEqual(
      elapsed(12, "asked", null, true),
    );
  });

  it("a started job without a readable start time counts from when it was asked — and says so, not 'since it started'", () => {
    expect(running({ startedAt: null })).toEqual(elapsed(35, "asked", null));
    expect(running({ startedAt: "not a time", samples: null })).toEqual(elapsed(35, "asked", null));
  });

  it("nothing readable at all, or a job that ended: nothing is printed", () => {
    expect(running({ startedAt: null, createdAt: "" })).toEqual({ kind: "none" });
    for (const status of ["completed", "failed", "cancelled", "expired"]) expect(running({ status })).toEqual({ kind: "none" });
  });

  it("a clock behind the start time reads 0, never a negative", () => {
    expect(secondsBetween(at(10), T0)).toBe(0);
    expect(secondsBetween(null, T0)).toBeNull();
  });
});

describe("the phase, from the job's real status", () => {
  it.each([
    ["queued", "queued"],
    ["running", "sending"],
    ["provider_pending", "making"],
    ["processing", "storing"],
    ["planning", "making"],
    ["rendering", "making"],
    ["completed", "done"],
    ["failed", "failed"],
    ["cancelled", "failed"],
    ["expired", "failed"],
    ["something-new", "failed"],
  ])("%s → %s", (status, phase) => {
    expect(jobPhase(status)).toBe(phase);
  });
});

describe("the shape held for a result", () => {
  const job = (capability: string, params: Record<string, unknown> = {}, status = "provider_pending") => ({ capability, params, status });
  const NO_SHAPE = ["upscale", "edit", "remove_bg", "relight", "i2v", "video_upscale", "t2i"] as const;
  it("is the shape the form sent, working or finished — the result comes back in it", () => {
    for (const status of ["provider_pending", "completed"]) {
      expect(cardShape(job("t2i", { aspect_ratio: "16:9" }, status))).toEqual({ aspect: "16 / 9", asked: true });
      expect(cardAspect(job("t2v", { aspect_ratio: "9:16" }, status))).toBe("9 / 16");
      expect(cardAspect(job("expand", { aspect_ratio: "4:3" }, status))).toBe("4 / 3");
    }
  });
  it("without one, a WORKING job's placeholder holds a neutral 3:2 picture or 16:9 clip — a placeholder, not a promise", () => {
    expect(cardShape(job("t2i", { prompt: "x" }))).toEqual({ aspect: "3 / 2", asked: false });
    for (const status of ["queued", "running", "provider_pending", "processing"]) expect(cardAspect(job("upscale", {}, status))).toBe("3 / 2");
    expect(cardAspect(job("t2v"))).toBe("16 / 9");
    expect(cardAspect(job("i2v"))).toBe("16 / 9");
    expect(cardAspect(job("video_upscale"))).toBe("16 / 9");
  });
  it("without one, a FINISHED card is the square it always was — a guessed 3:2 / 16:9 would crop the result (object-cover)", () => {
    // The regression this pins: an upscaled portrait, a square cut-out or a 9:16 i2v drawn into a 3:2 or 16:9 frame.
    for (const cap of NO_SHAPE) {
      for (const status of ["completed", "failed", "cancelled", "expired"]) {
        expect(cardShape(job(cap, {}, status))).toEqual({ aspect: "1 / 1", asked: false });
      }
    }
  });
  it("a sound is a wide bar, and a malformed shape is not trusted", () => {
    expect(cardAspect(job("tts"))).toBe("16 / 7");
    expect(cardAspect(job("tts", {}, "completed"))).toBe("16 / 7");
    expect(cardAspect(job("t2i", { aspect_ratio: "0:9" }))).toBe("3 / 2");
    expect(cardAspect(job("t2i", { aspect_ratio: "16:9;x" }))).toBe("3 / 2");
    expect(cardShape(job("t2i", { aspect_ratio: "0:9" }, "completed"))).toEqual({ aspect: "1 / 1", asked: false });
  });
});

describe("the server's clock, not the browser's", () => {
  // The rows' started_at / created_at are written by the database; the pill counts from the browser's Date.now().
  const header = (ms: number) => new Date(ms).toUTCString();
  const started = (offset: number, clientNow: number) =>
    progressReading({ status: "provider_pending", startedAt: at(0), createdAt: at(-5), now: clientNow + offset, samples: [60, 60, 60] });

  it("a browser a minute FAST is corrected: the job is 30 s along, not 90 s", () => {
    const serverNow = T0 + 30_000;
    const clientNow = serverNow + 60_000;
    const offset = clockOffset(header(serverNow), clientNow);
    expect(offset).toBeLessThan(-58_000);
    expect(offset).toBeGreaterThan(-60_000);
    expect(started(0, clientNow)).toMatchObject({ kind: "estimate", percent: 95 });
    expect(started(offset, clientNow)).toEqual({ kind: "estimate", percent: 50, samples: 3 });
  });

  it("a browser five minutes SLOW is corrected: the job is not 'just started' (or read as 0 s)", () => {
    const serverNow = T0 + 30_000;
    const clientNow = serverNow - 300_000;
    const offset = clockOffset(header(serverNow), clientNow);
    expect(offset).toBeGreaterThan(299_000);
    expect(started(0, clientNow)).toMatchObject({ kind: "estimate", percent: 0 });
    expect(started(offset, clientNow)).toEqual({ kind: "estimate", percent: 50, samples: 3 });
  });

  it("within the header's own rounding (whole seconds, the trip) there is nothing to correct", () => {
    expect(clockOffset(header(T0), T0)).toBe(0);
    expect(clockOffset(header(T0), T0 + 1_400)).toBe(0);
    expect(clockOffset(header(T0), T0 - 1_400)).toBe(0);
  });

  it("an unreadable, missing or absurd header is not believed: 0", () => {
    expect(clockOffset(null, T0)).toBe(0);
    expect(clockOffset(undefined, T0)).toBe(0);
    expect(clockOffset("not a date", T0)).toBe(0);
    expect(clockOffset(header(T0 - CLOCK_OFFSET_MAX_MS - 60_000), T0)).toBe(0);
    expect(clockOffset(header(T0 + CLOCK_OFFSET_MAX_MS + 60_000), T0)).toBe(0);
    expect(clockOffset(header(T0), Number.NaN)).toBe(0);
  });

  it("a new reading within the rounding of the one in use keeps it, so the seconds do not jitter on every poll", () => {
    expect(nextClockOffset(60_500, 60_000)).toBe(60_500);
    expect(nextClockOffset(60_500, 61_900)).toBe(60_500);
    expect(nextClockOffset(60_500, 0)).toBe(0);
    expect(nextClockOffset(0, -45_000)).toBe(-45_000);
  });
});

describe("the job rows carry their timing", () => {
  it("started_at and finished_at are kept when readable, null otherwise", () => {
    const [a, b] = coerceJobs([
      { id: "a", status: "running", started_at: at(0), finished_at: null },
      { id: "b", status: "queued", started_at: 5 },
    ]);
    expect(a!.started_at).toBe(at(0));
    expect(a!.finished_at).toBeNull();
    expect(b!.started_at).toBeNull();
  });
});

describe("the history: finished jobs' durations", () => {
  it("are started_at → finished_at in seconds; rows without both, backwards, or longer than a job may live are left out", () => {
    expect(
      durationsFrom([
        { started_at: at(0), finished_at: at(42) },
        { started_at: at(0), finished_at: null },
        { started_at: null, finished_at: at(5) },
        { started_at: at(10), finished_at: at(5) },
        { started_at: at(0), finished_at: at(3 * 3600) },
        { started_at: "x", finished_at: at(1) },
        null,
      ]),
    ).toEqual([42]);
    expect(durationsFrom("nope")).toEqual([]);
  });
  it("are at most 20", () => {
    expect(DURATION_SAMPLES).toBe(20);
    expect(durationsFrom(Array.from({ length: 30 }, () => ({ started_at: at(0), finished_at: at(9) })))).toHaveLength(20);
  });
});

describe("GET /api/creative/durations' input and read", () => {
  it("takes 1–4 well-formed model ids and nothing else", () => {
    expect(parseModelList("pic-1,vid.2")).toEqual(["pic-1", "vid.2"]);
    expect(parseModelList("pic-1,pic-1")).toEqual(["pic-1"]);
    expect(parseModelList(null)).toBeNull();
    expect(parseModelList("")).toBeNull();
    expect(parseModelList('pic-1,"),or(org_id.neq.x')).toBeNull();
    expect(parseModelList("A-UPPER")).toBeNull();
    expect(parseModelList(Array.from({ length: DURATION_MODELS_MAX + 1 }, (_, i) => `m${i}x`).join(","))).toBeNull();
  });

  const db = (answers: Record<string, DbAnswer>, calls: unknown[][] = []): CreativeDb => ({
    rpc: async () => ({ data: null, error: null }),
    readJob: async () => ({ data: null, error: null }),
    listJobs: async () => ({ data: [], error: null }),
    jobDurations: async (orgId, model, limit) => {
      calls.push([orgId, model, limit]);
      return answers[model] ?? { data: [], error: null };
    },
  });
  const ORG = "11111111-1111-4111-8111-111111111111";

  it("asks the member's own door, per model, for 20 rows of this organization", async () => {
    const calls: unknown[][] = [];
    const out = await listDurations(
      db({ "pic-1": { data: [{ started_at: at(0), finished_at: at(30) }], error: null } }, calls),
      ORG,
      ["pic-1", "vid-1"],
    );
    expect(out).toEqual({ status: 200, body: { durations: { "pic-1": [30], "vid-1": [] } } });
    expect(calls).toEqual([
      [ORG, "pic-1", 20],
      [ORG, "vid-1", 20],
    ]);
  });

  it("a model whose read failed is left out (its placeholder shows seconds), never filled with a guess", async () => {
    const out = await listDurations(db({ "pic-1": { data: null, error: { message: "boom", code: "XX000" } } }), ORG, ["pic-1"]);
    expect(out).toEqual({ status: 200, body: { durations: {} } });
  });

  it("without 0036 it is creative_unavailable; without an organization it asks nothing", async () => {
    const missing = await listDurations(db({ "pic-1": { data: null, error: { message: 'relation "creative_jobs" does not exist', code: "42P01" } } }), ORG, ["pic-1"]);
    expect(missing.status).toBe(503);
    const calls: unknown[][] = [];
    expect((await listDurations(db({}, calls), "nope", ["pic-1"])).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
