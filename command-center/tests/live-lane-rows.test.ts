/**
 * A live film's lane as strip rows (lib/studio/liveLaneRows.ts). What would break without these: a length nobody knows drawn as a
 * number, or a planned share drawn as measured; a piece nobody can read shown done; a failure without its reason; a refresh or a
 * film switch replaying every landing; the master shown ready (with a download) before any file exists.
 */
import { describe, expect, it } from "vitest";
import { coerceTimelineFilm } from "../lib/studio/timeline";
import type { FilmReading, LiveSegment } from "../lib/studio/liveGraph";
import { liveLane, type LanePiece } from "../lib/studio/liveLane";
import { assemblyReasonText, filmLength, flightIds, landedSeconds, laneRows, masterCell, masterRow, pieceLength, type LaneRowWords, type MasterWords } from "../lib/studio/liveLaneRows";
import { fmt } from "../lib/i18n";
import { studioLiveEn as c } from "../lib/i18n/studio-live/en";
import { S1, S2, filmJson, sceneJson } from "./films-fixtures";

const C1 = "c1000000-0000-4000-8000-0000000000c1";
const C2 = "c2000000-0000-4000-8000-0000000000c2";
const MP4 = "f1000000-0000-4000-8000-0000000000f1";
const OTHER_FILM = "0f000000-0000-4000-8000-0000000000ff";

const take = (id: string, kind: string, status: string, over: Record<string, unknown> = {}) => ({
  id, kind, status, version: 1, shot_index: kind === "keyframe" || kind === "narration" ? 0 : 1, attempt: 1, duration_s: null, result_asset_id: null, ...over,
});
const seg = (over: Partial<LiveSegment> = {}): LiveSegment => ({
  id: "s", status: "running", assemblyStatus: "planned", assemblyAssetId: null, confirmedCredits: 40, chargedCredits: null,
  assemblyConfirmedCredits: 8, assemblyChargedCredits: null, createdAt: "2026-11-21T00:00:00Z", ...over,
});
function reading(filmOver: Record<string, unknown>, scenes: Record<string, unknown>[], extra: { takes?: unknown[]; segments?: LiveSegment[] | null; errors?: [string, string][]; pauseReason?: string } = {}): FilmReading {
  const film = coerceTimelineFilm({ ...filmJson(filmOver, scenes), takes: extra.takes ?? [] });
  if (!film) throw new Error("fixture did not coerce");
  return { film, segments: extra.segments === undefined ? [seg()] : extra.segments, money: new Map(), errors: new Map(extra.errors ?? []), pauseReason: extra.pauseReason ?? null };
}
const none = new Map<string, number>();
const failure = (code: string | null) => (code && c.errors[code] ? c.errors[code] : code ? fmt(c.failedGeneric, { code }) : c.failedNoCode);
const W: LaneRowWords = { clip: c.kinds.clip, shot: c.lane.shot, voice: c.kinds.voice, master: c.lane.master.name, state: c.lane.state, failedWith: c.lane.failedWith, failure, fmt };
const MW: MasterWords = { ...c.lane.master, failed: c.lane.state.failed, failedWith: c.lane.failedWith, fmt, assembly: c.lane.assembly };
const failedAs = (reason: string) => fmt(c.lane.failedWith, { state: c.lane.state.failed, reason });

const twoScenes = (s1: unknown[], s2: unknown[] = [], film: Record<string, unknown> = { status: "running" }, extra = {}) =>
  reading(film, [sceneJson(S1, 0, { current_version: 1, planned_seconds: 8, takes: s1 }), sceneJson(S2, 1, { current_version: 1, planned_seconds: 6, takes: s2 })], extra);

describe("lengths keep their basis all the way to the strip", () => {
  it("an unknown length is never drawn as a number: no basis is null (hatched '?'), not 0", () => {
    // A scene with no planned seconds and a take that asked for none: nobody knows its length.
    const lane = liveLane(reading({ status: "running" }, [sceneJson(S1, 0, { current_version: 1, planned_seconds: 0, takes: [take("c1", "clip", "running")] })]), none);
    expect(lane.video[0].lengthBasis).toBeNull();
    expect(laneRows(lane, W)[0].length).toBeNull();
    expect(pieceLength({ length: Number.NaN, lengthBasis: "measured" })).toBeNull();
  });

  it("the plan's share is 'planned', never 'measured'; a measured file is measured; a request stays 'requested'", () => {
    const planned = laneRows(liveLane(twoScenes([take("c1", "clip", "completed", { result_asset_id: C1 })]), none), W);
    expect(planned[0].length).toEqual({ seconds: 8, basis: "planned" });
    const measured = laneRows(liveLane(twoScenes([take("c1", "clip", "completed", { result_asset_id: C1 })]), new Map([[C1, 8]])), W);
    expect(measured[0].length).toEqual({ seconds: 8, basis: "measured" });
    const voice = laneRows(liveLane(twoScenes([], [], { status: "running" }, { takes: [take("n1", "narration", "running", { duration_s: 12 })] }), none), W).find((r) => r.track === "audio")!;
    expect(voice.length).toEqual({ seconds: 12, basis: "requested" });
  });

  it("the clock leans on no unknown: one landed piece without a length makes the made-so-far unknown, and planned is not measured", () => {
    const lane = liveLane(twoScenes([take("c1", "clip", "completed", { result_asset_id: C1 })]), none);
    expect(landedSeconds(lane)).toEqual({ seconds: 8, basis: "planned" });
    const unknown = liveLane(reading({ status: "running" }, [sceneJson(S1, 0, { current_version: 1, planned_seconds: 0, takes: [take("c1", "clip", "completed", { result_asset_id: C1 })] })]), none);
    expect(landedSeconds(unknown)).toBeNull();
  });

  it("the clock carries its weakest basis: measured only when every landed piece was measured, '~' (requested) below that", () => {
    const measured = liveLane(twoScenes([take("c1", "clip", "completed", { result_asset_id: C1 })]), new Map([[C1, 8]]));
    expect(landedSeconds(measured)).toEqual({ seconds: 8, basis: "measured" });
    // A scene with no planned seconds whose take asked for 5: its landed length is only the request.
    const requested = liveLane(reading({ status: "running" }, [sceneJson(S1, 0, { current_version: 1, planned_seconds: 0, takes: [take("c1", "clip", "completed", { result_asset_id: C1, duration_s: 5 })] })]), none);
    expect(landedSeconds(requested)).toEqual({ seconds: 5, basis: "requested" });
  });

  it("the video's length is the master's measured file once it is ready, otherwise the plan, said to be the plan", () => {
    expect(filmLength(liveLane(twoScenes([]), none))).toEqual({ seconds: 14, basis: "planned" });
    const ready = liveLane(twoScenes([], [], { status: "ready" }, { segments: [seg({ assemblyStatus: "completed", assemblyAssetId: MP4 })] }), new Map([[MP4, 13.4]]));
    expect(filmLength(ready)).toEqual({ seconds: 13.4, basis: "measured" });
    // Ready but its file not measured: still the plan, never a guess called measured.
    const unmeasured = liveLane(twoScenes([], [], { status: "ready" }, { segments: [seg({ assemblyStatus: "completed", assemblyAssetId: MP4 })] }), none);
    expect(filmLength(unmeasured)).toEqual({ seconds: 14, basis: "planned" });
  });
});

describe("states in words", () => {
  it("unknown is never 'done': a completed take with no file is not made and says unknown", () => {
    const rows = laneRows(liveLane(twoScenes([take("c1", "clip", "completed")]), none), W);
    expect(rows[0]).toMatchObject({ made: false, status: "warn", statusWords: c.lane.state.unknown });
    expect(rows[0].statusWords).not.toBe(c.lane.state.landed);
    // A finished film whose slot has no row at all: unknown too, never made.
    const ended = laneRows(liveLane(twoScenes([], [], { status: "ready" }), none), W);
    expect(ended[0]).toMatchObject({ made: false, statusWords: c.lane.state.unknown });
  });

  it("made only for a landed piece, with its own thumbnail and no one else's", () => {
    const rows = laneRows(liveLane(twoScenes([take("c1", "clip", "completed", { result_asset_id: C1 })], [take("c2", "clip", "running")]), none), W, new Map([[C1, "/thumb/c1"], [C2, "/thumb/c2"]]));
    expect(rows[0]).toMatchObject({ made: true, status: "ok", thumb: "/thumb/c1", tag: "clip-01", name: fmt(c.kinds.clip, { n: 1 }) });
    expect(rows[1]).toMatchObject({ made: false, status: "run", thumb: null, statusWords: c.lane.state.working });
  });

  it("a failed piece carries its words: the stored error's sentence, or its code when the build has none", () => {
    const known = laneRows(liveLane(twoScenes([take("c1", "clip", "failed")], [], { status: "running" }, { errors: [["c1", "timeout"]] }), none), W);
    expect(known[0].status).toBe("fail");
    expect(known[0].statusWords).toBe(fmt(c.lane.failedWith, { state: c.lane.state.failed, reason: c.errors.timeout }));
    const other = laneRows(liveLane(twoScenes([take("c1", "clip", "failed")], [], { status: "running" }, { errors: [["c1", "vendor_said_no"]] }), none), W);
    expect(other[0].statusWords).toContain("vendor_said_no");
  });

  it("a scene of two shots names each shot, in play order, with the lane's tags", () => {
    const r = reading({ status: "running" }, [sceneJson(S1, 0, { current_version: 1, planned_seconds: 8, shot_count: 2 })]);
    const rows = laneRows(liveLane(r, none), W);
    expect(rows.filter((x) => x.track === "video").map((x) => [x.tag, x.name])).toEqual([
      ["clip-01.1", fmt(c.lane.shot, { n: 1, k: 1 })],
      ["clip-01.2", fmt(c.lane.shot, { n: 1, k: 2 })],
    ]);
  });
});

describe("flights", () => {
  const before = () => liveLane(twoScenes([take("c1", "clip", "running")], [take("c2", "clip", "running")]), none);
  const after = () => liveLane(twoScenes([take("c1", "clip", "completed", { result_asset_id: C1 })], [take("c2", "clip", "running")]), none);

  it("landedIds is empty on the first reading (a load or a refresh replays nothing) and holds only the new piece on the next", () => {
    expect(flightIds(null, after())).toEqual([]);
    expect(flightIds(before(), after())).toEqual([`v:${S1}:1`]);
    // The same reading again (a poll with no change): nothing new flies.
    expect(flightIds(after(), after())).toEqual([]);
  });

  it("a film switch flies nothing, even when the new film's pieces are landed", () => {
    const other = liveLane(reading({ id: OTHER_FILM, status: "running" }, [sceneJson(S1, 0, { current_version: 1, planned_seconds: 8, takes: [take("c1", "clip", "completed", { result_asset_id: C1 })] })]), none);
    expect(flightIds(before(), other)).toEqual([]);
  });
});

describe("the master", () => {
  it("shows 'not assembled yet' for pending, and no file to download without an asset", () => {
    const lane = liveLane(twoScenes([]), none);
    expect(masterCell(lane.master)).toEqual({ state: "pending" });
    const row = masterRow(lane.master, MW)!;
    expect(row).toMatchObject({ statusWords: c.lane.master.pending, made: false, length: null, thumb: null });
  });

  it("ready only with a recorded file; a completed assembly without one is unknown, never done", () => {
    const ready = liveLane(twoScenes([], [], { status: "ready" }, { segments: [seg({ assemblyStatus: "completed", assemblyAssetId: MP4 })] }), new Map([[MP4, 14]]));
    expect(masterCell(ready.master)).toEqual({ state: "ready", assetId: MP4 });
    expect(masterRow(ready.master, MW)).toMatchObject({ made: true, statusWords: c.lane.master.ready, length: { seconds: 14, basis: "measured" } });
    const noFile = liveLane(twoScenes([], [], { status: "ready" }, { segments: [seg({ assemblyStatus: "completed" })] }), none);
    expect(masterCell(noFile.master)).toEqual({ state: "unknown" });
    expect(masterRow(noFile.master, MW)).toMatchObject({ made: false, statusWords: c.lane.master.unknown });
  });

  it("a master whose length is only the plan's shows no length: the plan is not the film's", () => {
    const lane = liveLane(twoScenes([], [], { status: "ready" }, { segments: [seg({ assemblyStatus: "completed", assemblyAssetId: MP4 })] }), none);
    expect(masterRow(lane.master, MW)!.length).toBeNull();
  });

  it.each([
    ["running", { assemblyStatus: "running" }, c.lane.master.assembling],
    ["skipped", { assemblyStatus: "skipped" }, c.lane.master.skipped],
  ] as const)("%s reads its own words", (_n, over, words) => {
    expect(masterRow(liveLane(twoScenes([], [], { status: "running" }, { segments: [seg(over)] }), none).master, MW)!.statusWords).toBe(words);
  });

  it("failed gives the reason in words, never the stored word; an unreadable assembly is unknown", () => {
    const failed = liveLane(twoScenes([], [], { status: "failed" }, { segments: [seg({ assemblyStatus: "failed" })], pauseReason: "assembly_unavailable" }), none);
    expect(masterRow(failed.master, MW)).toMatchObject({ status: "fail", statusWords: failedAs(c.lane.assembly.reasons.assembly_unavailable), made: false });
    const odd = liveLane(twoScenes([], [], { status: "failed" }, { segments: [seg({ assemblyStatus: "failed" })], pauseReason: "gpu_on_fire" }), none);
    expect(masterRow(odd.master, MW)!.statusWords).toBe(failedAs(c.lane.assembly.generic));
    expect(masterRow(odd.master, MW)!.statusWords).not.toContain("gpu_on_fire");
    const unread = liveLane(twoScenes([], [], { status: "running" }, { segments: null }), none);
    expect(masterRow(unread.master, MW)!.statusWords).toBe(c.lane.master.unknown);
  });

  it("never in the rows: the master is the strip's slot, not a track", () => {
    const lane = liveLane(twoScenes([]), none);
    expect(laneRows(lane, W).some((r: { id: string }) => r.id === (lane.master as LanePiece).id)).toBe(false);
  });
});

describe("assemblyReasonText", () => {
  const CONTRACT = [
    "assembly_failed", "assembly_unavailable", "render_failed", "render_timed_out", "render_degraded", "output_mismatch", "store_failed",
    "narration_missing", "captions_failed", "disk_low", "review_copy_missing", "review_copy_too_large", "scene_not_shot", "assembly_not_enabled",
    "film_studio_off",
  ];

  it("a known reason maps to its own sentence, in every language, never the word itself", async () => {
    const { dictionaries } = await import("../lib/i18n");
    for (const loc of ["en", "ru", "uz"] as const) {
      const w = dictionaries[loc].studioLive.lane.assembly;
      for (const r of CONTRACT) {
        const out = assemblyReasonText(r, w);
        expect(out.text, `${loc} ${r}`).toBe(w.reasons[r]);
        expect(out.text).not.toContain(r);
        expect(out.text).not.toBe(w.generic);
      }
    }
  });

  it("an unknown reason never echoes its word: the generic line instead", () => {
    for (const r of ["gpu_on_fire", "constructor", "__proto__", "toString", null]) {
      const out = assemblyReasonText(r, c.lane.assembly);
      expect(out.text).toBe(c.lane.assembly.generic);
      if (r) expect(out.text).not.toContain(r);
    }
  });

  it("the remedy is always there, for a known reason, an unknown one and none", async () => {
    const { dictionaries } = await import("../lib/i18n");
    for (const loc of ["en", "ru", "uz"] as const) {
      const w = dictionaries[loc].studioLive.lane.assembly;
      for (const r of [...CONTRACT, "gpu_on_fire", null]) expect(assemblyReasonText(r, w).remedy.length, `${loc} ${r}`).toBeGreaterThan(0);
    }
  });

  it("a cause on our side says there is nothing to do; a cause in the project says start it again; an unknown one starts again", () => {
    const w = c.lane.assembly;
    for (const r of ["assembly_unavailable", "assembly_not_enabled", "disk_low", "film_studio_off", "store_failed", "render_degraded"]) {
      expect(assemblyReasonText(r, w), r).toEqual({ text: w.reasons[r], remedy: w.remedyOurs });
    }
    for (const r of ["narration_missing", "scene_not_shot", "captions_failed", "output_mismatch", "render_failed", "render_timed_out"]) {
      expect(assemblyReasonText(r, w), r).toEqual({ text: w.reasons[r], remedy: w.remedyAgain });
    }
    expect(assemblyReasonText("gpu_on_fire", w)).toEqual({ text: w.generic, remedy: w.remedyAgain });
  });
});
