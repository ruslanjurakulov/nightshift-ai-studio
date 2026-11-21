/**
 * The Studio's live view as data (lib/studio/liveGraph.ts). What would break without these: a step drawn as done while no row
 * says so, an assembly shown as finished when its table cannot be read, an upload called private without the uploader saying so,
 * a stage lit by an event of another stage, and polling that never stops on a finished film.
 */
import { describe, expect, it } from "vitest";
import { coerceTimelineFilm } from "../lib/studio/timeline";
import { filmGraph, runGraph, type LiveSegment, type RunEvent } from "../lib/studio/liveGraph";
import { S1, S2, filmJson, sceneJson } from "./films-fixtures";

const PIC = "a1000000-0000-4000-8000-0000000000a1";
const CLIP = "c1000000-0000-4000-8000-0000000000c1";
const MP4 = "f1000000-0000-4000-8000-0000000000f1";
const take = (id: string, kind: string, status: string, over: Record<string, unknown> = {}) => ({
  id, kind, status, version: 1, shot_index: kind === "keyframe" ? 0 : 1, attempt: 1, duration_s: 8, result_asset_id: null, ...over,
});

function reading(filmOver: Record<string, unknown>, scenes: Record<string, unknown>[], extra: { takes?: unknown[]; segments?: LiveSegment[] | null } = {}) {
  const raw = { ...filmJson(filmOver, scenes), takes: extra.takes ?? [] };
  const film = coerceTimelineFilm(raw);
  if (!film) throw new Error("fixture did not coerce");
  return { film, segments: extra.segments === undefined ? [] : extra.segments, money: new Map(), errors: new Map() };
}
const byId = (g: ReturnType<typeof filmGraph>) => new Map(g.nodes.map((n) => [n.id, n]));

describe("a film", () => {
  it("a draft with scenes: the script is written, every generated step waits, nothing is done that has no row", () => {
    const g = filmGraph(reading({ status: "draft" }, [sceneJson(S1, 0), sceneJson(S2, 1)]));
    const n = byId(g);
    expect(n.get("idea")?.status).toBe("done");
    expect(n.get("script")?.status).toBe("done");
    expect(n.get(`scene:${S1}:keyframe`)?.status).toBe("waiting");
    expect(n.get(`scene:${S2}:clip`)?.status).toBe("waiting");
    expect(n.get("music")?.status).toBe("none");
    expect(n.get("final")?.status).toBe("waiting");
    expect(g.settled).toBe(false);
  });

  it("running: each step takes its own take's status, and a done clip shows its file", () => {
    const g = filmGraph(
      reading({ status: "running" }, [
        sceneJson(S1, 0, { current_version: 1, takes: [take("k1", "keyframe", "completed", { result_asset_id: PIC }), take("c1", "clip", "completed", { result_asset_id: CLIP })] }),
        sceneJson(S2, 1, { current_version: 1, takes: [take("k2", "keyframe", "running")] }),
      ]),
    );
    const n = byId(g);
    expect(n.get(`scene:${S1}:keyframe`)).toMatchObject({ status: "done", assetId: PIC });
    expect(n.get(`scene:${S1}:clip`)).toMatchObject({ status: "done", assetId: CLIP });
    expect(n.get(`scene:${S2}:keyframe`)?.status).toBe("working");
    expect(n.get(`scene:${S2}:clip`)?.status).toBe("waiting");
  });

  it("a failed take shows failed with its stored error word, never as waiting", () => {
    const r = reading({ status: "running" }, [sceneJson(S1, 0, { current_version: 1, takes: [take("c1", "clip", "failed")] })]);
    r.errors.set("c1", "provider_timeout");
    const n = byId(filmGraph(r));
    expect(n.get(`scene:${S1}:clip`)).toMatchObject({ status: "failed", error: "provider_timeout" });
  });

  it("a superseded attempt is history: the newest attempt speaks for the step", () => {
    const g = filmGraph(
      reading({ status: "running" }, [
        sceneJson(S1, 0, { current_version: 1, takes: [take("c1", "clip", "superseded"), take("c2", "clip", "running", { attempt: 2 })] }),
      ]),
    );
    expect(byId(g).get(`scene:${S1}:clip`)?.status).toBe("working");
  });

  it("film_segments unreadable (0171 not applied): the assembly and the final video are unknown, not waiting or done", () => {
    const g = filmGraph(reading({ status: "assembling" }, [sceneJson(S1, 0)], { segments: null }));
    const n = byId(g);
    expect(n.get("assembly")?.status).toBe("unknown");
    expect(n.get("final")?.status).toBe("unknown");
  });

  it("the final video is done only when the segment recorded the file", () => {
    const seg = (over: Partial<LiveSegment>): LiveSegment => ({
      id: "s", status: "settled", assemblyStatus: "completed", assemblyAssetId: null, confirmedCredits: 40, chargedCredits: 30, assemblyChargedCredits: 6, createdAt: "2026-11-21T00:00:00Z", ...over,
    });
    const without = byId(filmGraph(reading({ status: "ready" }, [sceneJson(S1, 0)], { segments: [seg({})] })));
    expect(without.get("assembly")?.status).toBe("done");
    expect(without.get("final")?.status).toBe("unknown");
    const withFile = byId(filmGraph(reading({ status: "ready" }, [sceneJson(S1, 0)], { segments: [seg({ assemblyAssetId: MP4 })] })));
    expect(withFile.get("final")).toMatchObject({ status: "done", assetId: MP4 });
    expect(withFile.get("assembly")?.credits).toEqual({ held: 40, charged: 6 });
  });

  it("music that is gone from the library is said, not drawn as present", () => {
    const g = filmGraph(reading({ status: "running", music_asset_id: PIC }, [sceneJson(S1, 0)]));
    expect(byId(g).get("music")?.status).toBe("done");
    const gone = { ...filmJson({ status: "running", music_asset_id: PIC }, [sceneJson(S1, 0)]), music_missing: true };
    const film = coerceTimelineFilm(gone)!;
    expect(byId(filmGraph({ film, segments: [], money: new Map(), errors: new Map() })).get("music")).toMatchObject({ status: "failed", error: "music_missing" });
  });

  it("a scene that starts from the previous frame has no keyframe step, and one from a missing picture says so", () => {
    const g = filmGraph(
      reading({ status: "running" }, [
        sceneJson(S1, 0, { first_frame: "previous" }),
        sceneJson(S2, 1, { first_frame: "asset", first_frame_asset_id: PIC, first_frame_missing: true }),
      ]),
    );
    const n = byId(g);
    expect(n.get(`scene:${S1}:keyframe`)?.status).toBe("none");
    expect(n.get(`scene:${S2}:keyframe`)).toMatchObject({ status: "failed", error: "first_frame_missing", assetId: null });
  });
});

describe("a channel run", () => {
  const ev = (ts: string, event: string, over: Partial<RunEvent> = {}): RunEvent => ({ ts, event, status: null, agent: null, ...over });
  const stages = (g: ReturnType<typeof runGraph>) => Object.fromEntries(g.nodes.map((n) => [n.id, n.status]));

  it("with no readable run row every stage is unknown", () => {
    const g = runGraph({ job: null, events: [ev("2026-11-21T00:00:01Z", "script.completed")] });
    expect(new Set(Object.values(stages(g)))).toEqual(new Set(["unknown"]));
  });

  it("a running run: done, working and waiting stages come from their own events", () => {
    const g = runGraph({
      job: { status: "running", startedAt: "2026-11-21T00:00:00Z", finishedAt: null, error: null },
      events: [ev("2026-11-21T00:00:01Z", "topic.selected"), ev("2026-11-21T00:00:02Z", "research.started"), ev("2026-11-21T00:00:03Z", "research.completed"), ev("2026-11-21T00:00:04Z", "script.started")],
    });
    expect(stages(g)).toMatchObject({ topic: "done", research: "done", script: "working", voice: "waiting", upload: "waiting" });
    expect(g.settled).toBe(false);
  });

  it("an agent failure lights only its own stage, and the stages after it were not reached", () => {
    const g = runGraph({
      job: { status: "failed", startedAt: "t0", finishedAt: "t9", error: "voice_unavailable" },
      events: [ev("2026-11-21T00:00:01Z", "topic.selected"), ev("2026-11-21T00:00:02Z", "script.completed"), ev("2026-11-21T00:00:03Z", "agent.failed", { agent: "voice_gate" })],
    });
    const s = stages(g);
    expect(s.voice).toBe("failed");
    expect(s.render).toBe("skipped");
    expect(g.nodes.find((n) => n.id === "voice")?.error).toBe("voice_unavailable");
    expect(g.settled).toBe(true);
  });

  it("a stage still running when the run ended is stopped, not working", () => {
    const g = runGraph({ job: { status: "failed", startedAt: "t0", finishedAt: "t9", error: null }, events: [ev("2026-11-21T00:00:05Z", "render.started")] });
    expect(stages(g).render).toBe("stopped");
  });

  it("the fact-check is lit only by the publish gate's verdict; without one it is not claimed", () => {
    const passed = runGraph({ job: { status: "running", startedAt: "t0", finishedAt: null, error: null }, events: [ev("2026-11-21T00:00:01Z", "publish.allowed"), ev("2026-11-21T00:00:02Z", "voice.started")] });
    expect(stages(passed).factcheck).toBe("done");
    const silent = runGraph({ job: { status: "running", startedAt: "t0", finishedAt: null, error: null }, events: [ev("2026-11-21T00:00:02Z", "voice.started")] });
    expect(stages(silent).factcheck).toBe("unknown");
  });

  it("the upload says private only when the uploader recorded it", () => {
    const g = runGraph({
      job: { status: "completed", startedAt: "t0", finishedAt: "t9", error: null },
      events: [ev("2026-11-21T00:00:08Z", "upload.completed"), ev("2026-11-21T00:00:09Z", "video.published", { privacy: "private" })],
    });
    expect(g.nodes.find((n) => n.id === "upload")).toMatchObject({ status: "done", privacy: "private" });
    const unrecorded = runGraph({ job: { status: "completed", startedAt: "t0", finishedAt: "t9", error: null }, events: [ev("2026-11-21T00:00:08Z", "upload.completed")] });
    expect(unrecorded.nodes.find((n) => n.id === "upload")?.privacy).toBeNull();
  });
});
