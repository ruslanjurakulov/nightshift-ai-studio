/**
 * The live lane as data (lib/studio/liveLane.ts). What would break without these: a planned length drawn as measured, a scene lit
 * as landed before its shots are, a retry hidden behind its failed first attempt, an unreadable master drawn as "on its way", a
 * refresh that replays every landing, and a worker's host name or credits leaking into the activity log.
 */
import { describe, expect, it } from "vitest";
import { coerceTimelineFilm } from "../lib/studio/timeline";
import type { FilmReading, LiveSegment } from "../lib/studio/liveGraph";
import { landedSince, liveLane, logLines, masterFromSegments, type MasterReading } from "../lib/studio/liveLane";
import { S1, S2, filmJson, sceneJson } from "./films-fixtures";

const C1 = "c1000000-0000-4000-8000-0000000000c1";
const C2 = "c2000000-0000-4000-8000-0000000000c2";
const VO = "a1000000-0000-4000-8000-0000000000a1";
const MP4 = "f1000000-0000-4000-8000-0000000000f1";
const T1 = "71000000-0000-4000-8000-000000000001";
const T2 = "72000000-0000-4000-8000-000000000002";

const take = (id: string, kind: string, status: string, over: Record<string, unknown> = {}) => ({
  id, kind, status, version: 1, shot_index: kind === "keyframe" || kind === "narration" ? 0 : 1, attempt: 1, duration_s: null, result_asset_id: null, ...over,
});
const seg = (over: Partial<LiveSegment> = {}): LiveSegment => ({
  id: "s", status: "running", assemblyStatus: "planned", assemblyAssetId: null, confirmedCredits: 40, chargedCredits: null,
  assemblyConfirmedCredits: 8, assemblyChargedCredits: null, createdAt: "2026-11-21T00:00:00Z", ...over,
});

function reading(
  filmOver: Record<string, unknown>,
  scenes: Record<string, unknown>[],
  extra: { takes?: unknown[]; segments?: LiveSegment[] | null; events?: Record<string, unknown>[]; pauseReason?: string | null } = {},
): FilmReading & { errors: Map<string, string> } {
  const raw = { ...filmJson(filmOver, scenes), takes: extra.takes ?? [] };
  const film = coerceTimelineFilm(raw);
  if (!film) throw new Error("fixture did not coerce");
  return {
    film,
    segments: extra.segments === undefined ? [] : extra.segments,
    money: new Map(),
    errors: new Map<string, string>(),
    pauseReason: extra.pauseReason ?? null,
    rawEvents: extra.events ? { rows: extra.events, total: extra.events.length } : null,
  };
}
const none = new Map<string, number>();

describe("the lane's video pieces", () => {
  it("an unmeasured length is never marked known: requested seconds and the planned share both stay lengthKnown false", () => {
    const r = reading({ status: "running" }, [
      sceneJson(S1, 0, { current_version: 1, planned_seconds: 8, takes: [take("c1", "clip", "completed", { result_asset_id: C1, duration_s: 8 })] }),
      sceneJson(S2, 1, { current_version: 1, planned_seconds: 6 }),
    ]);
    const lane = liveLane(r, none);
    expect(lane.video[0]).toMatchObject({ state: "landed", length: 8, lengthKnown: false });
    expect(lane.video[1]).toMatchObject({ state: "pending", length: 6, lengthKnown: false });
    const measured = liveLane(r, new Map([[C1, 7.96]]));
    expect(measured.video[0]).toMatchObject({ length: 7.96, lengthKnown: true });
  });

  it("one landed shot of a 3-shot scene shows as landed while the others stay pending, each in its share of the slot", () => {
    const lane = liveLane(
      reading({ status: "running" }, [
        sceneJson(S1, 0, { current_version: 1, planned_seconds: 9, shot_count: 3, takes: [take("c1", "clip", "completed", { result_asset_id: C1 }), take("e2", "extend", "planned", { shot_index: 2 })] }),
      ]),
      none,
    );
    expect(lane.video.map((p) => [p.tag, p.state, p.start])).toEqual([
      ["clip-01.1", "landed", 0],
      ["clip-01.2", "pending", 3],
      ["clip-01.3", "pending", 6],
    ]);
    expect(lane.landed).toBe(1);
  });

  it("a superseded first attempt shows retried and the attempt-2 take drives the slot, then the retry's own state takes over", () => {
    const scene = (second: string) =>
      reading({ status: "running" }, [
        sceneJson(S1, 0, { current_version: 1, takes: [take("c1", "clip", "superseded"), take("c2", "clip", second, { attempt: 2, result_asset_id: second === "completed" ? C2 : null })] }),
      ]);
    const waiting = scene("planned");
    waiting.errors.set("c1", "timeout");
    expect(liveLane(waiting, none).video[0]).toMatchObject({ state: "retried", takeId: "c2", error: "timeout" });
    expect(liveLane(scene("running"), none).video[0]).toMatchObject({ state: "working", takeId: "c2" });
    expect(liveLane(scene("completed"), none).video[0]).toMatchObject({ state: "landed", takeId: "c2", assetId: C2 });
  });

  it("scene order follows position, not array order", () => {
    const lane = liveLane(reading({ status: "running" }, [sceneJson(S2, 1, { planned_seconds: 5 }), sceneJson(S1, 0, { planned_seconds: 8 })]), none);
    expect(lane.video.map((p) => [p.sceneId, p.tag, p.start])).toEqual([
      [S1, "clip-01", 0],
      [S2, "clip-02", 8],
    ]);
    expect(lane.planned).toBe(13);
  });

  it("a completed take with no file is not a landing, and a failed one carries its stored error word", () => {
    const r = reading({ status: "running" }, [
      sceneJson(S1, 0, { current_version: 1, takes: [take("c1", "clip", "completed")] }),
      sceneJson(S2, 1, { current_version: 1, takes: [take("c2", "clip", "failed")] }),
    ]);
    r.errors.set("c2", "moderated");
    const lane = liveLane(r, none);
    expect(lane.video[0].state).toBe("unknown");
    expect(lane.video[1]).toMatchObject({ state: "failed", error: "moderated" });
  });

  it("a scene with no planned seconds leaves its own and every later start unknown, never a guessed position", () => {
    const lane = liveLane(reading({ status: "running" }, [sceneJson(S1, 0, { planned_seconds: 0 }), sceneJson(S2, 1, { planned_seconds: 6 })]), none);
    expect(lane.video.map((p) => p.start)).toEqual([null, null]);
    expect(lane.video[0]).toMatchObject({ length: null, lengthKnown: false });
  });

  it("the narration is one audio piece: measured only from its file's recorded length", () => {
    const r = reading({ status: "running" }, [sceneJson(S1, 0, { planned_seconds: 8 })], { takes: [take("n1", "narration", "completed", { result_asset_id: VO })] });
    expect(liveLane(r, none).audio).toEqual([expect.objectContaining({ tag: "voice", state: "landed", start: 0, length: 8, lengthKnown: false, assetId: VO })]);
    expect(liveLane(r, new Map([[VO, 7.5]])).audio[0]).toMatchObject({ length: 7.5, lengthKnown: true });
  });
});

describe("the master", () => {
  it("unreadable segments make the master unknown, not pending", () => {
    const r = reading({ status: "running" }, [sceneJson(S1, 0)], { segments: null });
    expect(masterFromSegments(r)).toEqual({ state: "unknown", assetId: null, reason: null });
    expect(liveLane(r, none).master?.state).toBe("unknown");
  });

  it("a failed assembly carries pause_reason, and the contract's own word only when none was recorded", () => {
    const r = reading({ status: "paused" }, [sceneJson(S1, 0)], { segments: [seg({ assemblyStatus: "failed" })], pauseReason: "assembly_unavailable" });
    expect(masterFromSegments(r)).toEqual({ state: "failed", assetId: null, reason: "assembly_unavailable" });
    expect(liveLane(r, none).master).toMatchObject({ state: "failed", error: "assembly_unavailable" });
    const bare = reading({ status: "paused" }, [sceneJson(S1, 0)], { segments: [seg({ assemblyStatus: "failed" })] });
    expect(masterFromSegments(bare)?.reason).toBe("assembly_failed");
  });

  it("the adapter reads today's segment rules: running is assembling, completed with a file is ready, planned is not assembled", () => {
    const at = (s: Partial<LiveSegment>, status = "running") => masterFromSegments(reading({ status }, [sceneJson(S1, 0)], { segments: [seg(s)] }));
    expect(at({ assemblyStatus: "running" })?.state).toBe("assembling");
    expect(at({ assemblyStatus: "completed", assemblyAssetId: MP4 }, "ready")).toEqual({ state: "ready", assetId: MP4, reason: null });
    expect(at({ assemblyStatus: "completed" }, "ready")?.state).toBe("unknown");
    expect(at({ assemblyStatus: "planned" })?.state).toBe("not_assembled");
    expect(masterFromSegments(reading({ status: "queued" }, [sceneJson(S1, 0)], { segments: [] }))?.state).toBe("not_assembled");
  });

  it("a draft with no segment has no master at all", () => {
    const r = reading({ status: "draft" }, [sceneJson(S1, 0)], { segments: [] });
    expect(masterFromSegments(r)).toBeNull();
    expect(liveLane(r, none).master).toBeNull();
  });

  it("the newest segment speaks for the master, not an older settled one", () => {
    const r = reading({ status: "running" }, [sceneJson(S1, 0)], {
      segments: [seg({ id: "old", assemblyStatus: "failed", createdAt: "2026-11-20T00:00:00Z" }), seg({ id: "new", assemblyStatus: "running", createdAt: "2026-11-21T00:00:00Z" })],
    });
    expect(masterFromSegments(r)?.state).toBe("assembling");
  });

  it("an explicitly passed MasterReading overrides the segments (S4's read model wins)", () => {
    const r = reading({ status: "running" }, [sceneJson(S1, 0, { planned_seconds: 8 })], { segments: [seg({ assemblyStatus: "planned" })] });
    const s4: MasterReading = { state: "ready", assetId: MP4, reason: null };
    expect(liveLane(r, new Map([[MP4, 8.04]]), s4).master).toMatchObject({ state: "landed", assetId: MP4, length: 8.04, lengthKnown: true });
    expect(liveLane(r, none, null).master).toBeNull();
    expect(liveLane(r, none).master?.state).toBe("pending");
  });
});

describe("landings between readings", () => {
  const first = reading({ status: "running" }, [
    sceneJson(S1, 0, { current_version: 1, takes: [take("c1", "clip", "completed", { result_asset_id: C1 })] }),
    sceneJson(S2, 1, { current_version: 1, takes: [take("c2", "clip", "running")] }),
  ]);
  const second = reading({ status: "running" }, [
    sceneJson(S1, 0, { current_version: 1, takes: [take("c1", "clip", "completed", { result_asset_id: C1 })] }),
    sceneJson(S2, 1, { current_version: 1, takes: [take("c2", "clip", "completed", { result_asset_id: C2 })] }),
  ]);

  it("a refresh (prev null) flies nothing, even with pieces already landed", () => {
    expect(landedSince(null, liveLane(second, none))).toEqual([]);
  });

  it("the second reading flies exactly the newly landed piece, and the same reading again flies nothing", () => {
    const a = liveLane(first, none);
    const b = liveLane(second, none);
    expect(landedSince(a, b).map((p) => p.tag)).toEqual(["clip-02"]);
    expect(landedSince(b, liveLane(second, none))).toEqual([]);
  });
});

describe("activity lines", () => {
  const ev = (id: number, event: string, detail: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
    id, event, created_at: `2026-11-22T10:00:${String(id).padStart(2, "0")}Z`, scene_id: null, detail, ...over,
  });

  it("event detail.worker never appears in a log line, nor credits or free text", () => {
    const r = reading({ status: "running" }, [sceneJson(S1, 0)], {
      events: [ev(1, "segment_claimed", { segment_id: "s", worker: "film-worker-host-7", attempt: 1 }), ev(2, "take_failed", { take_id: T1, kind: "clip", failure: "vendor said: secret", confirmed: 4, charged: 0 }, { scene_id: S1 })],
    });
    const text = JSON.stringify(logLines(r));
    expect(text).not.toContain("film-worker-host-7");
    expect(text).not.toContain("secret");
    expect(text).not.toMatch(/"(confirmed|charged|worker|failure)"/);
    expect(logLines(r)[0]).toMatchObject({ tag: "seg", family: "seg", word: "segment_claimed" });
  });

  it("an unknown event word keeps its code, tagged log", () => {
    const r = reading({ status: "running" }, [sceneJson(S1, 0)], { events: [ev(1, "segment_skipped"), ev(2, "brand_new_word", { kind: "clip" })] });
    expect(logLines(r).map((l) => [l.word, l.tag, l.family])).toEqual([
      ["segment_skipped", "seg", "seg"],
      ["brand_new_word", "log", "log"],
    ]);
  });

  it("take events are tagged from their own row: kind, scene and shot_index, or the take they name when detail has no shot", () => {
    const r = reading(
      { status: "running" },
      [sceneJson(S1, 0), sceneJson(S2, 1, { shot_count: 3, takes: [take(T2, "extend", "failed", { shot_index: 2 })] })],
      {
        takes: [take(T1, "narration", "completed", { result_asset_id: VO })],
        events: [
          ev(1, "take_completed", { take_id: "k", kind: "keyframe", shot_index: 0 }, { scene_id: S2 }),
          ev(2, "take_completed", { kind: "clip", shot_index: 1 }, { scene_id: S1 }),
          ev(3, "take_failed", { take_id: T2, kind: "extend" }, { scene_id: S2 }),
          ev(4, "take_completed", { take_id: T1, kind: "narration", shot_index: 0 }),
          ev(5, "assembly_completed", { asset_id: MP4 }),
          ev(6, "started"),
        ],
      },
    );
    expect(logLines(r).map((l) => [l.tag, l.family, l.scene, l.shot])).toEqual([
      ["key-02", "key", 2, null],
      ["clip-01", "clip", 1, 1],
      ["clip-02.2", "clip", 2, 2],
      ["voice", "voice", null, null],
      ["asm", "asm", null, null],
      ["film", "film", null, null],
    ]);
    expect(logLines(r)[2].takeId).toBe(T2);
  });

  it("a kind or shot_index that is not a plain small value is dropped, never echoed into a tag", () => {
    const r = reading({ status: "running" }, [sceneJson(S1, 0, { shot_count: 2 })], {
      events: [ev(1, "take_completed", { kind: "<img src=x>", shot_index: 1 }, { scene_id: S1 }), ev(2, "take_completed", { kind: "clip", shot_index: 1e9 }, { scene_id: S1 })],
    });
    const lines = logLines(r);
    expect(lines[0]).toMatchObject({ tag: "take", family: "log" });
    expect(lines[1]).toMatchObject({ tag: "clip-01", shot: null });
  });
});
