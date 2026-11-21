import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import {
  STALE_AFTER_S,
  coerceWorkers,
  isMissingWorkerTable,
  sortWorkers,
  workerView,
  type WorkerRow,
} from "../lib/workers";
import { PIPELINE_UNKNOWN, isWaitingForCheck, parsePipelineState, pipelineIsDown } from "../lib/media";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

const row = (over: Partial<WorkerRow> = {}): WorkerRow => ({
  workerId: "nightshift-media-01",
  kind: "media",
  state: "running",
  detail: null,
  version: null,
  startedAt: ago(1000),
  updatedAt: ago(10),
  ...over,
});

describe("coerceWorkers", () => {
  it("keeps well-formed rows and drops anything else", () => {
    const rows = coerceWorkers([
      { worker_id: "w1", kind: "media", state: "failed", detail: "NIGHTSHIFT_MEDIA_DIR is not a writable directory", version: "v1", started_at: ago(5), updated_at: ago(1) },
      { worker_id: "w2", kind: "billing", state: "running" }, // unknown kind
      { worker_id: "w3", kind: "media", state: "healthy" }, // unknown state
      { kind: "media", state: "running" }, // no id
      null,
      "x",
    ]);
    expect(rows.map((r) => r.workerId)).toEqual(["w1"]);
    expect(rows[0].detail).toContain("NIGHTSHIFT_MEDIA_DIR");
  });

  it("is empty for anything that is not an array", () => {
    expect(coerceWorkers(null)).toEqual([]);
    expect(coerceWorkers({})).toEqual([]);
  });
});

describe("workerView", () => {
  it("a fresh running worker is running", () => {
    expect(workerView(row(), NOW)).toMatchObject({ shown: "running", ageSeconds: 10 });
  });

  it("a heartbeat older than two minutes is 'not reporting', never running", () => {
    expect(workerView(row({ updatedAt: ago(STALE_AFTER_S) }), NOW).shown).toBe("running"); // the boundary is "longer than"
    expect(workerView(row({ updatedAt: ago(STALE_AFTER_S + 1) }), NOW).shown).toBe("notReporting");
    expect(workerView(row({ state: "starting", updatedAt: ago(600) }), NOW).shown).toBe("notReporting");
  });

  it("an unreadable heartbeat is not believed", () => {
    expect(workerView(row({ updatedAt: null }), NOW)).toMatchObject({ shown: "notReporting", ageSeconds: null });
    expect(workerView(row({ updatedAt: "not a date" }), NOW).shown).toBe("notReporting");
  });

  it("a reported failure stays a failure, however old", () => {
    const v = workerView(row({ state: "failed", detail: "ffmpeg and ffprobe are required", updatedAt: ago(5000) }), NOW);
    expect(v.shown).toBe("failed");
    expect(v.detail).toBe("ffmpeg and ffprobe are required");
    expect(workerView(row({ state: "stopped", updatedAt: ago(5000) }), NOW).shown).toBe("stopped");
  });

  it("sorts media first, then by kind and id", () => {
    const views = [
      workerView(row({ kind: "other", workerId: "w4" }), NOW),
      workerView(row({ kind: "media", workerId: "w3" }), NOW),
      workerView(row({ kind: "creative", workerId: "w2" }), NOW),
      workerView(row({ kind: "media", workerId: "w1" }), NOW),
    ];
    expect(sortWorkers(views).map((v) => `${v.kind}:${v.workerId}`)).toEqual([
      "media:w1",
      "media:w3",
      "creative:w2",
      "other:w4",
    ]);
  });
});

describe("a missing table is told apart from a failed read", () => {
  it("recognises the Postgres and PostgREST 'no such table' errors only", () => {
    expect(isMissingWorkerTable({ code: "42P01", message: 'relation "worker_status" does not exist' })).toBe(true);
    expect(isMissingWorkerTable({ code: "PGRST205", message: "Could not find the table" })).toBe(true);
    expect(isMissingWorkerTable({ code: "XX000", message: "boom" })).toBe(false);
    expect(isMissingWorkerTable({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isMissingWorkerTable(null)).toBe(false);
  });
});

describe("media pipeline state (what a customer is told)", () => {
  it("parses the four states and the age", () => {
    expect(parsePipelineState({ state: "ok", age_seconds: 4 })).toEqual({ state: "ok", ageSeconds: 4 });
    expect(parsePipelineState({ state: "stale", age_seconds: 900.7 })).toEqual({ state: "stale", ageSeconds: 900 });
    expect(parsePipelineState({ state: "failed", age_seconds: 2 }).state).toBe("failed");
    expect(parsePipelineState({ state: "unknown", age_seconds: null })).toEqual(PIPELINE_UNKNOWN);
  });

  it("anything else is unknown, never ok", () => {
    for (const bad of [null, undefined, "ok", [], 7, {}, { state: "healthy" }, { state: "OK" }, { age_seconds: 3 }]) {
      expect(parsePipelineState(bad)).toEqual(PIPELINE_UNKNOWN);
    }
    expect(parsePipelineState({ state: "ok", age_seconds: -1 })).toEqual({ state: "ok", ageSeconds: null });
  });

  it("only stale and failed are 'down'", () => {
    expect(pipelineIsDown({ state: "stale", ageSeconds: 500 })).toBe(true);
    expect(pipelineIsDown({ state: "failed", ageSeconds: 5 })).toBe(true);
    expect(pipelineIsDown({ state: "ok", ageSeconds: 5 })).toBe(false);
    expect(pipelineIsDown({ state: "unknown", ageSeconds: null })).toBe(false);
    expect(pipelineIsDown(undefined)).toBe(false);
  });

  it("an upload is waiting on the check while uploaded or being checked", () => {
    for (const status of ["uploaded", "ingesting"] as const) expect(isWaitingForCheck({ status })).toBe(true);
    for (const status of ["requested", "receiving", "ingested", "rejected", "expired"] as const) {
      expect(isWaitingForCheck({ status })).toBe(false);
    }
  });
});

describe("strings exist in en, ru and uz", () => {
  const dicts = { en, ru, uz };
  it("worker panel and library lines are translated and keep their placeholders", () => {
    for (const [name, d] of Object.entries(dicts)) {
      expect(d.media.pipelineDown.length, name).toBeGreaterThan(10);
      expect(d.media.status.paused.length, name).toBeGreaterThan(3);
      expect(d.workers.heartbeat, name).toContain("{t}");
      expect(d.workers.version, name).toContain("{v}");
      for (const k of ["media", "creative", "pipeline", "other"] as const) expect(d.workers.kinds[k].length).toBeGreaterThan(1);
      for (const k of ["starting", "running", "failed", "stopped", "notReporting"] as const) expect(d.workers.states[k].length).toBeGreaterThan(1);
    }
    expect(ru.media.pipelineDown).not.toBe(en.media.pipelineDown);
    expect(uz.media.pipelineDown).not.toBe(en.media.pipelineDown);
    expect(ru.workers.notEnabled).not.toBe(en.workers.notEnabled);
    expect(uz.workers.notEnabled).not.toBe(en.workers.notEnabled);
  });

  it("the customer line is the agreed honest sentence", () => {
    expect(en.media.pipelineDown).toBe(
      "File checking is temporarily unavailable. Your upload is kept and will be processed when it is back.",
    );
  });
});
