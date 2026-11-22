/**
 * The live lane as data (lib/studio/liveLane.ts). What would break without these: a planned or requested length drawn as measured,
 * pieces that overlap because their start and length come from different bases, a scene lit as landed before its shots are, a
 * retry hidden behind its failed first attempt, an unreadable or skipped master drawn as "on its way", a refresh or a failed read
 * that replays a landing, the lane and the canvas disagreeing on a slot, and a worker's host name or credits in the activity log.
 */
import { describe, expect, it } from "vitest";
import { coerceTimelineFilm } from "../lib/studio/timeline";
import { filmGraph, type FilmReading, type LiveSegment, type LiveStatus } from "../lib/studio/liveGraph";
import { landedSince, liveLane, logLines, masterFromSegments, type LanePiece, type LiveLane, type MasterReading, type PieceState } from "../lib/studio/liveLane";
import { S1, S2, filmJson, sceneJson } from "./films-fixtures";

const C1 = "c1000000-0000-4000-8000-0000000000c1";
const C2 = "c2000000-0000-4000-8000-0000000000c2";
const C3 = "c3000000-0000-4000-8000-0000000000c3";
const VO = "a1000000-0000-4000-8000-0000000000a1";
const MP4 = "f1000000-0000-4000-8000-0000000000f1";
const T1 = "71000000-0000-4000-8000-000000000001";
const T2 = "72000000-0000-4000-8000-000000000002";
const OTHER_FILM = "0f000000-0000-4000-8000-0000000000ff";

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

/** Consecutive video pieces never overlap: each ends at or before the next one starts. */
function expectNoOverlap(lane: LiveLane) {
  for (let k = 1; k < lane.video.length; k++) {
    const a = lane.video[k - 1];
    const b = lane.video[k];
    expect(a.start! + a.length!).toBeLessThanOrEqual(b.start! + 1e-9);
  }
}

describe("the lane's video pieces", () => {
  it("an unmeasured length is never marked measured: a slot is the plan's share, and the file's own seconds stay null", () => {
    const r = reading({ status: "running" }, [
      sceneJson(S1, 0, { current_version: 1, planned_seconds: 8, takes: [take("c1", "clip", "completed", { result_asset_id: C1, duration_s: 8 })] }),
      sceneJson(S2, 1, { current_version: 1, planned_seconds: 6 }),
    ]);
    const lane = liveLane(r, none);
    expect(lane.video[0]).toMatchObject({ state: "landed", length: 8, lengthBasis: "planned", startKnown: false, fileS: null });
    expect(lane.video[1]).toMatchObject({ state: "pending", length: 6, lengthBasis: "planned", startKnown: false, fileS: null });
  });

  it("a requested length longer than the plan does not push pieces into each other: the slot is the plan, the request is not a length", () => {
    const lane = liveLane(
      reading({ status: "running" }, [
        sceneJson(S1, 0, { current_version: 1, planned_seconds: 8, takes: [take("c1", "clip", "completed", { result_asset_id: C1, duration_s: 10 })] }),
        sceneJson(S2, 1, { current_version: 1, planned_seconds: 6, takes: [take("c2", "clip", "running", { duration_s: 10 })] }),
      ]),
      none,
    );
    expect(lane.video.map((p) => [p.start, p.length, p.lengthBasis])).toEqual([
      [0, 8, "planned"],
      [8, 6, "planned"],
    ]);
    expectNoOverlap(lane);
  });

  it("a scene whose every shot is measured is placed where the worker cuts it (sceneWindow), and the file's seconds are reported apart", () => {
    const lane = liveLane(
      reading({ status: "running" }, [
        sceneJson(S1, 0, {
          current_version: 1, planned_seconds: 9, shot_count: 3,
          takes: [take("c1", "clip", "completed", { result_asset_id: C1 }), take("e2", "extend", "completed", { shot_index: 2, result_asset_id: C2 }), take("e3", "extend", "completed", { shot_index: 3, result_asset_id: C3 })],
        }),
        sceneJson(S2, 1, { planned_seconds: 6 }),
      ]),
      new Map([[C1, 4], [C2, 4], [C3, 4]]),
    );
    const [a, b, c, d] = lane.video;
    expect([a, b, c].map((p) => [p.startKnown, p.lengthBasis, p.fileS])).toEqual([
      [true, "measured", 4],
      [true, "measured", 4],
      [true, "measured", 4],
    ]);
    expect(a.start).toBe(0);
    expect(a.length).toBeCloseTo(4);
    expect(b.start).toBeCloseTo(4);
    expect(b.length).toBeCloseTo(3.958);
    expect(c.start).toBeCloseTo(7.958);
    expect(c.length).toBeCloseTo(1.042);
    expect(d).toMatchObject({ start: 9, startKnown: false });
    expectNoOverlap(lane);
  });

  it("one landed shot of a 3-shot scene shows as landed while the others stay pending, each in its share of the slot", () => {
    const lane = liveLane(
      reading({ status: "running" }, [
        sceneJson(S1, 0, { current_version: 1, planned_seconds: 9, shot_count: 3, takes: [take("c1", "clip", "completed", { result_asset_id: C1 }), take("e2", "extend", "planned", { shot_index: 2 })] }),
      ]),
      new Map([[C1, 3.1]]),
    );
    expect(lane.video.map((p) => [p.tag, p.state, p.start, p.startKnown])).toEqual([
      ["clip-01.1", "landed", 0, false],
      ["clip-01.2", "pending", 3, false],
      ["clip-01.3", "pending", 6, false],
    ]);
    expect(lane.video[0]).toMatchObject({ length: 3, lengthBasis: "planned", fileS: 3.1 });
    expect(lane.landed).toBe(1);
  });

  it("a stored shot count above 0166's limit of 3 draws no slot the worker will never make", () => {
    const r = reading({ status: "running" }, [sceneJson(S1, 0, { shot_count: 3 })]);
    (r.film.view.scenes[0] as { shotCount: number }).shotCount = 7;
    expect(liveLane(r, none).video).toHaveLength(3);
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

  it("a scene with no planned seconds ([0, 6]) leaves every start, the film's planned total and the fallback lengths unknown", () => {
    const lane = liveLane(
      reading({ status: "running" }, [sceneJson(S1, 0, { planned_seconds: 0 }), sceneJson(S2, 1, { planned_seconds: 6 })], {
        takes: [take("n1", "narration", "running")],
        segments: [seg()],
      }),
      none,
    );
    expect(lane.planned).toBeNull();
    expect(lane.video.map((p) => p.start)).toEqual([null, null]);
    expect(lane.video[0]).toMatchObject({ length: null, lengthBasis: null });
    expect(lane.video[1]).toMatchObject({ length: 6, lengthBasis: "planned", startKnown: false });
    expect(lane.audio[0]).toMatchObject({ length: null, lengthBasis: null });
    expect(lane.master).toMatchObject({ state: "pending", length: null, lengthBasis: null });
  });

  it("the narration is one audio piece: measured only from its file, else its request, else the plan, each saying which", () => {
    const scenes = [sceneJson(S1, 0, { planned_seconds: 8 })];
    const done = reading({ status: "running" }, scenes, { takes: [take("n1", "narration", "completed", { result_asset_id: VO })] });
    expect(liveLane(done, none).audio).toEqual([expect.objectContaining({ tag: "voice", state: "landed", start: 0, length: 8, lengthBasis: "planned", fileS: null, assetId: VO })]);
    expect(liveLane(done, new Map([[VO, 7.5]])).audio[0]).toMatchObject({ length: 7.5, lengthBasis: "measured", fileS: 7.5 });
    const asked = reading({ status: "running" }, scenes, { takes: [take("n1", "narration", "running", { duration_s: 9 })] });
    expect(liveLane(asked, none).audio[0]).toMatchObject({ length: 9, lengthBasis: "requested", fileS: null });
  });
});

describe("the lane and the canvas agree on which take drives a slot", () => {
  // filmGraph's LiveStatus as the lane names it (a completed take WITH its file, so "done" is "landed" on both).
  const AS_LANE: Partial<Record<LiveStatus, PieceState>> = { done: "landed", working: "working", waiting: "pending", failed: "failed", skipped: "skipped", unknown: "unknown" };

  it("with current_version null, a completed v1 and a v2 that is only superseded: both read the v1 take", () => {
    const r = reading({ status: "running" }, [
      sceneJson(S1, 0, { current_version: null, takes: [take("c1", "clip", "completed", { result_asset_id: C1 }), take("c2", "clip", "superseded", { version: 2 })] }),
    ], { takes: [take("n1", "narration", "completed", { result_asset_id: VO }), take("n2", "narration", "superseded", { version: 2 })] });
    const nodes = new Map(filmGraph(r).nodes.map((n) => [n.id, n.status]));
    const lane = liveLane(r, none);
    expect(lane.video[0]).toMatchObject({ takeId: "c1", state: AS_LANE[nodes.get(`scene:${S1}:clip`)!] });
    expect(lane.audio[0]).toMatchObject({ takeId: "n1", state: AS_LANE[nodes.get("voice")!] });
    expect(lane.video[0].state).toBe("landed");
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

  it.each(["draft", "paused", "cancelled"])("a skipped assembly on a %s film reads skipped, never pending (not 'not assembled yet')", (status) => {
    const r = reading({ status }, [sceneJson(S1, 0)], { segments: [seg({ status: "released", assemblyStatus: "skipped" })] });
    expect(masterFromSegments(r)).toEqual({ state: "skipped", assetId: null, reason: null });
    expect(liveLane(r, none).master?.state).toBe("skipped");
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

  it("the newest segment speaks for the master, and one with an unreadable time never outranks a dated one", () => {
    const r = reading({ status: "running" }, [sceneJson(S1, 0)], {
      segments: [seg({ id: "bad", assemblyStatus: "failed", createdAt: "not a time" }), seg({ id: "old", assemblyStatus: "failed", createdAt: "2026-11-20T00:00:00Z" }), seg({ id: "new", assemblyStatus: "running", createdAt: "2026-11-21T00:00:00Z" })],
    });
    expect(masterFromSegments(r)?.state).toBe("assembling");
  });

  it("an explicitly passed MasterReading overrides the segments (S4's read model wins)", () => {
    const r = reading({ status: "running" }, [sceneJson(S1, 0, { planned_seconds: 8 })], { segments: [seg({ assemblyStatus: "planned" })] });
    const s4: MasterReading = { state: "ready", assetId: MP4, reason: null };
    expect(liveLane(r, new Map([[MP4, 8.04]]), s4).master).toMatchObject({ state: "landed", assetId: MP4, length: 8.04, lengthBasis: "measured", fileS: 8.04 });
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
  const tags = (ps: LanePiece[]) => ps.map((p) => p.tag);

  it("a refresh (prev null) flies nothing, even with pieces already landed", () => {
    expect(landedSince(null, liveLane(second, none))).toEqual([]);
  });

  it("the second reading flies exactly the newly landed piece, and the same reading again flies nothing", () => {
    const a = liveLane(first, none);
    const b = liveLane(second, none);
    expect(tags(landedSince(a, b))).toEqual(["clip-02"]);
    expect(landedSince(b, liveLane(second, none))).toEqual([]);
  });

  it("a failed read between two readings (ready, unknown, ready) does not fly the master again", () => {
    const r = (segments: LiveSegment[] | null) => reading({ status: "ready" }, [sceneJson(S1, 0)], { segments });
    const a = liveLane(r([seg({ assemblyStatus: "completed", assemblyAssetId: MP4 })]), none);
    const b = liveLane(r(null), none);
    const c = liveLane(r([seg({ assemblyStatus: "completed", assemblyAssetId: MP4 })]), none);
    expect(b.master?.state).toBe("unknown");
    expect(landedSince(a, b)).toEqual([]);
    expect(landedSince(b, c)).toEqual([]);
    const assembling = liveLane(r([seg({ assemblyStatus: "running" })]), none);
    expect(tags(landedSince(assembling, c))).toEqual(["master"]);
  });

  it("the lane of another film is no previous reading: switching films flies nothing", () => {
    const other = liveLane(reading({ status: "running", id: OTHER_FILM }, [sceneJson(S1, 0)]), none);
    expect(other.film).toBe(OTHER_FILM);
    expect(landedSince(other, liveLane(second, none))).toEqual([]);
  });
});

describe("activity lines", () => {
  const ev = (id: number, event: string, detail: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
    id, event, created_at: `2026-11-22T10:00:${String(id % 60).padStart(2, "0")}Z`, scene_id: null, detail, ...over,
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

  it("take events are tagged from their own row: the named take's kind and shot first, else detail's kind and shot_index", () => {
    const r = reading(
      { status: "running" },
      [sceneJson(S1, 0), sceneJson(S2, 1, { shot_count: 3, takes: [take(T2, "extend", "failed", { shot_index: 2 })] })],
      {
        takes: [take(T1, "narration", "completed", { result_asset_id: VO })],
        events: [
          ev(1, "take_completed", { take_id: "k", kind: "keyframe", shot_index: 0 }, { scene_id: S2 }),
          ev(2, "take_completed", { kind: "clip", shot_index: 1 }, { scene_id: S1 }),
          // detail says shot 3 and a keyframe; the take it names is the extend of shot 2, and the row wins.
          ev(3, "take_failed", { take_id: T2.toUpperCase(), kind: "keyframe", shot_index: 3 }, { scene_id: S2 }),
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

  it("a kind or shot_index that is not a plain small shot is dropped, never echoed into a tag", () => {
    const r = reading({ status: "running" }, [sceneJson(S1, 0, { shot_count: 2 })], {
      events: [
        ev(1, "take_completed", { kind: "<img src=x>", shot_index: 1 }, { scene_id: S1 }),
        ev(2, "take_completed", { kind: "clip", shot_index: 1e9 }, { scene_id: S1 }),
        ev(3, "take_completed", { kind: "extend", shot_index: 0 }, { scene_id: S1 }),
      ],
    });
    const lines = logLines(r);
    expect(lines[0]).toMatchObject({ tag: "take", family: "log" });
    expect(lines[1]).toMatchObject({ tag: "clip-01", shot: null });
    expect(lines[2]).toMatchObject({ tag: "clip-01", shot: null });
  });

  it("two events in the same instant keep the database's order: f:999 before f:1000", () => {
    const at = "2026-11-22T10:00:00Z";
    const r = reading({ status: "running" }, [sceneJson(S1, 0)], { events: [ev(1000, "segment_settled", {}, { created_at: at }), ev(999, "segment_claimed", {}, { created_at: at })] });
    expect(logLines(r).map((l) => l.id)).toEqual(["f:999", "f:1000"]);
  });

  it("a gathered line with no readable time or a scene that is not a positive whole number is not trusted", () => {
    const r = reading({ status: "running" }, [sceneJson(S1, 0)], { events: [] });
    const lines = logLines(r, {
      total: 3,
      items: [
        { id: "f:1", at: "not a time", word: "started", scene: null, kind: null },
        { id: "f:2", at: "2026-11-22T10:00:02Z", word: "take_completed", scene: 0, kind: "clip" },
        { id: "f:3", at: "2026-11-22T10:00:03Z", word: "take_completed", scene: 1.5, kind: "keyframe" },
      ],
    });
    expect(lines.map((l) => [l.id, l.tag, l.scene])).toEqual([
      ["f:2", "clip", null],
      ["f:3", "key", null],
    ]);
  });
});
