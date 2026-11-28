/**
 * The Studio's live view as data (lib/studio/liveGraph.ts). What would break without these: a step drawn as done while no row
 * says so, an assembly shown as finished when its table cannot be read, an upload called private without the uploader saying so,
 * a stage lit by an event of another stage, and polling that never stops on a finished film.
 */
import { describe, expect, it } from "vitest";
import { coerceTimelineFilm } from "../lib/studio/timeline";
import { briefGraph, coerceBrief, coerceFilmLive, coerceRunLive, filmGraph, runGraph, type LiveSegment, type RunEvent } from "../lib/studio/liveGraph";
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
    expect(n.get(`scene#1:keyframe`)?.status).toBe("waiting");
    expect(n.get(`scene#2:clip`)?.status).toBe("waiting");
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
    expect(n.get(`scene#1:keyframe`)).toMatchObject({ status: "done", assetId: PIC });
    expect(n.get(`scene#1:clip`)).toMatchObject({ status: "done", assetId: CLIP });
    expect(n.get(`scene#2:keyframe`)?.status).toBe("working");
    expect(n.get(`scene#2:clip`)?.status).toBe("waiting");
  });

  it("a failed take shows failed with its stored error word, never as waiting", () => {
    const r = reading({ status: "running" }, [sceneJson(S1, 0, { current_version: 1, takes: [take("c1", "clip", "failed")] })]);
    r.errors.set("c1", "provider_timeout");
    const n = byId(filmGraph(r));
    expect(n.get(`scene#1:clip`)).toMatchObject({ status: "failed", error: "provider_timeout" });
  });

  it("without current_version (no migration writes it yet) a finished clip still shows its file", () => {
    const g = filmGraph(reading({ status: "running" }, [sceneJson(S1, 0, { current_version: null, takes: [take("c1", "clip", "completed", { result_asset_id: CLIP })] })]));
    expect(byId(g).get(`scene#1:clip`)).toMatchObject({ status: "done", assetId: CLIP });
  });

  it("a superseded attempt is history: the newest attempt speaks for the step", () => {
    const g = filmGraph(
      reading({ status: "running" }, [
        sceneJson(S1, 0, { current_version: 1, takes: [take("c1", "clip", "superseded"), take("c2", "clip", "running", { attempt: 2 })] }),
      ]),
    );
    expect(byId(g).get(`scene#1:clip`)?.status).toBe("working");
  });

  it("film_segments unreadable (0171 not applied): the assembly and the final video are unknown, not waiting or done", () => {
    const g = filmGraph(reading({ status: "assembling" }, [sceneJson(S1, 0)], { segments: null }));
    const n = byId(g);
    expect(n.get("assembly")?.status).toBe("unknown");
    expect(n.get("final")?.status).toBe("unknown");
  });

  it("the final video is done only when the segment recorded the file", () => {
    const seg = (over: Partial<LiveSegment>): LiveSegment => ({
      id: "s", status: "settled", assemblyStatus: "completed", assemblyAssetId: null, confirmedCredits: 40, chargedCredits: 30, assemblyConfirmedCredits: 8, assemblyChargedCredits: 6, createdAt: "2026-11-21T00:00:00Z", ...over,
    });
    const without = byId(filmGraph(reading({ status: "ready" }, [sceneJson(S1, 0)], { segments: [seg({})] })));
    expect(without.get("assembly")?.status).toBe("done");
    expect(without.get("final")?.status).toBe("unknown");
    const withFile = byId(filmGraph(reading({ status: "ready" }, [sceneJson(S1, 0)], { segments: [seg({ assemblyAssetId: MP4 })] })));
    expect(withFile.get("final")).toMatchObject({ status: "done", assetId: MP4 });
    expect(withFile.get("assembly")?.credits).toEqual({ held: 8, charged: 6 });
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
    expect(n.get(`scene#1:keyframe`)?.status).toBe("none");
    expect(n.get(`scene#2:keyframe`)).toMatchObject({ status: "failed", error: "first_frame_missing", assetId: null });
  });
  it("a failed assembly names the worker's recorded reason (films.pause_reason), and the generic word only when none was recorded", () => {
    const seg: LiveSegment = { id: "s", status: "settled", assemblyStatus: "failed", assemblyAssetId: null, confirmedCredits: 40, chargedCredits: 30, assemblyConfirmedCredits: 8, assemblyChargedCredits: 0, createdAt: "2026-11-21T00:00:00Z" };
    const withReason = coerceFilmLive({ film: filmJson({ status: "paused", pause_reason: "assembly_unavailable" }, [sceneJson(S1, 0)]), segments: [{ id: "s", status: "settled", assembly_status: "failed", created_at: "2026-11-21T00:00:00Z" }], takes: [] })!;
    expect(withReason.pauseReason).toBe("assembly_unavailable");
    expect(byId(filmGraph(withReason)).get("assembly")).toMatchObject({ status: "failed", error: "assembly_unavailable" });
    expect(byId(filmGraph(reading({ status: "paused" }, [sceneJson(S1, 0)], { segments: [seg] }))).get("assembly")?.error).toBe("assembly_failed");
  });
});

describe("the activity panel's order", () => {
  it("two events in the same instant keep the database's order: f:999 before f:1000, not string order", () => {
    const at = "2026-11-22T10:00:00Z";
    const raw = { film: { ...filmJson({ status: "running" }, [sceneJson(S1, 0)]), events: [{ id: 1000, event: "segment_settled", created_at: at, detail: {} }, { id: 999, event: "segment_claimed", created_at: at, detail: {} }] }, segments: [], takes: [] };
    const g = filmGraph(coerceFilmLive(raw)!);
    expect(g.activity?.items.map((i) => i.id)).toEqual(["f:999", "f:1000"]);
  });
});

describe("the live route's answer", () => {
  it("segments or takes null stay not known; the money and error words come through", () => {
    const raw = { film: filmJson({ status: "running" }, [sceneJson(S1, 0)]), segments: null, takes: [{ id: "t1", error_code: "provider_timeout", confirmed_credits: "4.00", charged_credits: null }] };
    const r = coerceFilmLive(raw)!;
    expect(r.segments).toBeNull();
    expect(r.errors.get("t1")).toBe("provider_timeout");
    expect(r.money.get("t1")).toEqual({ held: 4, charged: null });
    expect(coerceFilmLive({ film: { nope: true } })).toBeNull();
  });
});

describe("a channel run", () => {
  const ev = (ts: string, event: string, over: Partial<RunEvent> = {}): RunEvent => ({ ts, event, status: null, agent: null, ...over });
  const stages = (g: ReturnType<typeof runGraph>) => Object.fromEntries(g.nodes.map((n) => [n.id, n.status]));

  it("with no readable run row every stage is unknown", () => {
    const g = runGraph({ job: null, events: [ev("2026-11-21T00:00:01Z", "script.completed")] });
    expect(new Set(Object.values(stages(g)))).toEqual(new Set(["unknown"]));
  });

  it("events that could not be read leave every stage unknown, even with the job row", () => {
    const g = runGraph(coerceRunLive({ job: { status: "running", startedAt: "t0", finishedAt: null, error: null }, events: null }));
    expect(new Set(Object.values(stages(g)))).toEqual(new Set(["unknown"]));
  });

  it("a malformed answer has no job: unknown, never waiting", () => {
    expect(coerceRunLive({ events: [] }).job).toBeNull();
    expect(coerceRunLive(null)).toEqual({ job: null, events: null, window: null });
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

  it("the publish gate comes after the render and is lit only by its own verdict; no fact-check node is claimed", () => {
    const g = runGraph({ job: { status: "running", startedAt: "t0", finishedAt: null, error: null }, events: [ev("2026-11-21T00:00:02Z", "voice.started")] });
    const ids = g.nodes.map((n) => n.id);
    expect(ids).not.toContain("factcheck");
    expect(ids.indexOf("gate")).toBe(ids.indexOf("render") + 1);
    expect(stages(g).gate).toBe("waiting");
    const passed = runGraph({ job: { status: "running", startedAt: "t0", finishedAt: null, error: null }, events: [ev("2026-11-21T00:00:09Z", "render.completed"), ev("2026-11-21T00:00:10Z", "publish.allowed")] });
    expect(stages(passed).gate).toBe("done");
  });

  it("a run that ended with no events reaching us: every stage unknown, and the run's own failure is said", () => {
    const g = runGraph({ job: { status: "failed", startedAt: "t0", finishedAt: "t9", error: "render" }, events: [] });
    expect(new Set(Object.values(stages(g)))).toEqual(new Set(["unknown"]));
    expect(g.runError).toBe("render");
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

  describe("on the Actions backend (no row: the channel's events since the dispatch)", () => {
    const win = (minutes: number) => ({ since: "2026-11-21T00:00:00.000Z", now: new Date(Date.parse("2026-11-21T00:00:00.000Z") + minutes * 60000).toISOString() });

    it("a running dispatch lights stages from its events, and the rest wait", () => {
      const g = runGraph({ job: null, window: win(10), events: [ev("2026-11-21T00:02:00Z", "topic.selected"), ev("2026-11-21T00:03:00Z", "script.started")] });
      expect(stages(g)).toMatchObject({ topic: "done", script: "working", render: "waiting" });
      expect(g.settled).toBe(false);
    });

    it("the upload ends it, and says private only as recorded", () => {
      const g = runGraph({ job: null, window: win(40), events: [ev("2026-11-21T00:38:00Z", "video.published", { privacy: "private" })] });
      expect(g.nodes.find((n) => n.id === "upload")).toMatchObject({ status: "done", privacy: "private" });
      expect(g.settled).toBe(true);
    });

    it("past the workflow's time limit with no last event: the running stage stopped and the rest are not known", () => {
      const g = runGraph({ job: null, window: win(120), events: [ev("2026-11-21T00:20:00Z", "render.started")] });
      const s = stages(g);
      expect(s.render).toBe("stopped");
      expect(s.upload).toBe("unknown");
      expect(g.settled).toBe(true);
    });

    it("no events at all yet is waiting, not done or failed", () => {
      const g = runGraph({ job: null, window: win(1), events: [] });
      expect(new Set(Object.values(stages(g)))).toEqual(new Set(["waiting"]));
    });
  });
});

describe("a channel run's live facts (workflow and hold)", () => {
  const win = { since: "2026-11-21T10:00:00Z", now: "2026-11-21T10:05:00Z" };
  it("the run's video: absent is not asked, malformed is none, a real one comes through", () => {
    expect(coerceRunLive({ job: null, window: win, events: [] }).video).toBeUndefined();
    expect(coerceRunLive({ job: null, window: win, events: [], video: { id: "", state: "held" } }).video).toBeNull();
    expect(coerceRunLive({ job: null, window: win, events: [], video: { id: "x", state: "public" } }).video).toBeNull();
    expect(runGraph(coerceRunLive({ job: null, window: win, events: [], video: { id: "held-1", state: "held" } })).video).toEqual({ id: "held-1", state: "held" });
  });

  it("absent from the answer is not asked; present and malformed is not known", () => {
    expect(coerceRunLive({ job: null, window: win, events: [] }).workflow).toBeUndefined();
    expect(coerceRunLive({ job: null, window: win, events: [], workflow: { state: "weird" }, hold: { state: "open", amount: "12.00" } })).toMatchObject({
      workflow: null,
      hold: { state: "open", amount: 12, captured: null },
    });
  });

  it("GitHub saying the job finished does not settle the run: its events may still be syncing, so stages read not known and the view keeps reading", () => {
    const g = runGraph(coerceRunLive({ job: null, window: win, events: [], workflow: { state: "completed", conclusion: "failure" } }));
    expect(new Set(g.nodes.map((n) => n.status))).toEqual(new Set(["unknown"]));
    expect(g.settled).toBe(false);
    expect(g.runError ?? null).toBeNull();
    // A stage whose start arrived but not its end is not "working" once GitHub says the job is over, nor "stopped" or "not reached".
    const ev = (event: string, ts: string) => ({ ts, event, status: "ok", agent: null });
    const part = runGraph(
      coerceRunLive({ job: null, window: win, events: [ev("topic.selected", "2026-11-21T10:01:00Z"), ev("research.started", "2026-11-21T10:02:00Z")], workflow: { state: "completed", conclusion: "failure" } }),
    );
    expect(part.nodes.find((n) => n.id === "topic")?.status).toBe("done");
    expect(part.nodes.find((n) => n.id === "research")?.status).toBe("unknown");
    expect(part.nodes.find((n) => n.id === "upload")?.status).toBe("unknown");
    expect(g.workflow).toEqual({ state: "completed", conclusion: "failure" });
  });

  it("GitHub running keeps the stages waiting and the view reading", () => {
    const g = runGraph(coerceRunLive({ job: null, window: win, events: [], workflow: { state: "in_progress" } }));
    expect(new Set(g.nodes.map((n) => n.status))).toEqual(new Set(["waiting"]));
    expect(g.settled).toBe(false);
  });

  it("a finished job with an upload event reads completed: the stages it reached are done", () => {
    const ev = (event: string, ts: string) => ({ ts, event, status: "ok", agent: null });
    const g = runGraph(
      coerceRunLive({
        job: null, window: win, workflow: { state: "completed", conclusion: "success" },
        events: [ev("topic.selected", "2026-11-21T10:01:00Z"), ev("upload.completed", "2026-11-21T10:04:00Z")],
      }),
    );
    expect(g.nodes.find((n) => n.id === "upload")?.status).toBe("done");
    expect(g.nodes.find((n) => n.id === "research")?.status).toBe("unknown");
    expect(g.settled).toBe(true);
  });
});

describe("events that arrive live and events that wait for the mirror", () => {
  it("a stage whose end event has not arrived, while a later stage already began, is not known: never still working", () => {
    const ev = (event: string, ts: string) => ({ ts, event, status: "ok", agent: null });
    const g = runGraph(
      coerceRunLive({
        job: null,
        window: { since: "2026-11-21T10:00:00Z", now: "2026-11-21T10:20:00Z" },
        events: [ev("render.started", "2026-11-21T10:10:00Z"), ev("publish.allowed", "2026-11-21T10:15:00Z"), ev("upload.started", "2026-11-21T10:16:00Z")],
      }),
    );
    expect(g.nodes.find((n) => n.id === "render")?.status).toBe("unknown");
    expect(g.nodes.find((n) => n.id === "gate")?.status).toBe("done");
    expect(g.nodes.find((n) => n.id === "upload")?.status).toBe("working");
  });
});

describe("activity (the plan's own log)", () => {
  it("a film's film_events become lines in time order, numbered by scene, with only known words kept from detail", () => {
    const fj = filmJson({ status: "running" }, [sceneJson(S1, 0), sceneJson(S2, 1)]) as Record<string, unknown>;
    fj.events = [
      { id: 3, event: "take_failed", scene_id: S2, actor: null, actor_role: "service", created_at: "2026-11-21T10:03:00Z",
        detail: { kind: "clip", error_code: "timeout", confirmed: 12, charged: 0, basis: "<script>x</script>" } },
      { id: 1, event: "started", scene_id: null, actor: null, actor_role: "service", created_at: "2026-11-21T10:00:00Z", detail: null },
      { id: 2, event: "take_completed", scene_id: S1, actor: null, actor_role: "service", created_at: "2026-11-21T10:02:00Z", detail: { kind: "keyframe" } },
      { id: 4, event: "Bad Word!", created_at: "2026-11-21T10:04:00Z" },
      { id: 5, event: "saved", created_at: "not a time" },
    ];
    fj.events_total = 120;
    const g = filmGraph(coerceFilmLive({ film: fj, segments: [], takes: [] })!);
    expect(g.activity?.total).toBe(120);
    expect(g.activity?.items.map((i) => [i.word, i.scene, i.kind])).toEqual([
      ["started", null, null],
      ["take_completed", 1, "keyframe"],
      ["take_failed", 2, "clip"],
      ["Bad Word!", null, null],
    ]);
    // detail is never carried as text: credits, the basis and any free field stay out of the browser's lines.
    expect(JSON.stringify(g.activity)).not.toMatch(/script|basis|confirmed|charged|timeout/);
  });

  it("a film_json without events (an older database) has no activity; a run's events become lines oldest first", () => {
    const fj = filmJson({ status: "running" }, [sceneJson(S1, 0)]) as Record<string, unknown>;
    delete fj.events;
    expect(filmGraph(coerceFilmLive({ film: fj, segments: [], takes: [] })!).activity).toBeNull();
    const ev = (event: string, ts: string) => ({ ts, event, status: "ok", agent: null });
    const g = runGraph(coerceRunLive({ job: null, window: { since: "2026-11-21T10:00:00Z", now: "2026-11-21T10:05:00Z" }, events: [ev("script.started", "2026-11-21T10:02:00Z"), ev("topic.selected", "2026-11-21T10:01:00Z")] }));
    expect(g.activity?.items.map((i) => i.word)).toEqual(["topic.selected", "script.started"]);
    expect(runGraph(coerceRunLive({ job: null, window: { since: "2026-11-21T10:00:00Z", now: "2026-11-21T10:05:00Z" }, events: null })).activity).toBeNull();
  });
});

describe("the brief, before Create", () => {
  // BRIEF v1 as GET /api/brain/session/<id> returns it (docs/studio/NIGHTSHIFT_AI.md).
  const raw = {
    version: 1, session_id: "b0000000-0000-4000-8000-0000000000b0", status: "drafting", kind: "short",
    title: "Desert sword", idea: "Two heroes cross the desert",
    story: { logline: "A sword is lost; it must be found before sunset.", conflict: "" },
    chapters: [{ id: "ch1", title: "Cold open", start_s: 0, beats: [] }],
    characters: [{ id: "hero", name: "Aziz", asset_id: null, source: "prompt" }],
    locations: [{ id: "desert", name: "Desert", asset_id: PIC }],
    props: [{ id: "sword", name: "Sword" }],
    scenes: [
      { id: S1, n: 1, title: "Dunes", visual_prompt: "Aziz in the dunes", character_ids: ["hero"], location_id: "desert", prop_ids: [] },
      { id: S2, n: 2, title: "Sand", visual_prompt: "The sword in the sand", character_ids: ["ghost"], location_id: null, prop_ids: ["sword"] },
    ],
    voice: { mode: "clip_audio" },
    music: { mode: "off" },
    price: { state: "priced", total_credits: 30, nodes: { [S1]: 12 }, spendable: 300, fits: true, shorter: null },
    handoff: null,
    smuggled: "<script>",
  };
  const brief = coerceBrief(raw)!;

  it("draws every step as a draft: no lamp is lit, nothing reads as running or done but a reference already made", () => {
    const g = briefGraph(brief);
    const statuses = new Set(g.nodes.map((n) => n.status));
    expect(statuses.has("working")).toBe(false);
    expect(g.nodes.find((n) => n.id === "ref:desert")?.status).toBe("done");
    expect(g.nodes.filter((n) => n.id !== "ref:desert" && n.status !== "none").every((n) => n.status === "draft")).toBe(true);
    expect(g.settled).toBe(false);
  });

  it("a scene carries its own cast by name instead of a wire from each reference; an unknown reference is not named", () => {
    const g = briefGraph(brief);
    const cast = (id: string) => g.nodes.find((n) => n.id === id)?.cast;
    expect(g.edges.some((e) => e.from.startsWith("ref:") || e.to.startsWith("ref:"))).toBe(false);
    expect(cast(`scene#1:keyframe`)).toEqual(expect.arrayContaining(["Aziz", "Desert"]));
    expect(cast(`scene#1:clip`)).toEqual(cast(`scene#1:keyframe`));
    expect(cast(`scene#2:keyframe`)).toContain("Sword");
    expect(g.nodes.some((n) => n.id === "ref:ghost")).toBe(false);
  });

  it("a price is only where the backend gave one, never guessed, and none at all unless the server says priced", () => {
    const g = briefGraph(brief);
    expect(g.nodes.find((n) => n.id === `scene#1:clip`)?.price).toBe(12);
    expect(g.nodes.find((n) => n.id === `scene#2:clip`)?.price).toBeNull();
    expect(g.nodes.find((n) => n.id === "assembly")?.price).toBeNull();
    expect(g.nodes.find((n) => n.id === "music")?.status).toBe("none");
    for (const state of ["unpriced", "failed", "exempt", undefined]) {
      const b = coerceBrief({ ...raw, price: { ...raw.price, state } })!;
      expect(briefGraph(b).nodes.every((n) => n.price == null), String(state)).toBe(true);
    }
    expect(briefGraph(coerceBrief({ ...raw, price: { state: "priced", nodes: { [S1]: "12; drop" } } })!).nodes.every((n) => n.price == null)).toBe(true);
  });

  it("voice off, or spoken by the video model inside each clip, is no voice step, as the live film draws it; not asked yet is still planned", () => {
    expect(briefGraph(coerceBrief({ ...raw, voice: { mode: "clip_audio" } })!).nodes.find((n) => n.id === "voice")?.status).toBe("none");
    expect(briefGraph(coerceBrief({ ...raw, voice: { mode: "off" } })!).nodes.find((n) => n.id === "voice")?.status).toBe("none");
    expect(briefGraph(coerceBrief({ ...raw, voice: undefined })!).nodes.find((n) => n.id === "voice")?.status).toBe("draft");
  });

  it("the steps keep the ids the live film uses, so Create lights them without a redraw", () => {
    const draftIds = new Set(briefGraph(brief).nodes.map((n) => n.id));
    const live = filmGraph(reading({ status: "running" }, [sceneJson(S1, 0), sceneJson(S2, 1)]));
    for (const n of live.nodes) expect(draftIds.has(n.id)).toBe(true);
  });

  it("a long video is drawn as the channel run's own stages, with the ids the live run uses", () => {
    const g = briefGraph(coerceBrief({ ...raw, kind: "long" })!);
    const live = runGraph({ job: null, window: { since: "2026-11-21T00:00:00Z", now: "2026-11-21T00:01:00Z" }, events: [] });
    expect(g.nodes.map((n) => n.id)).toEqual(live.nodes.map((n) => n.id));
    expect(g.nodes.every((n) => n.status === "draft")).toBe(true);
  });

  it("a handoff is followed only once created, and only when it names a real target", () => {
    const film = "f0000000-0000-4000-8000-0000000000f0";
    const ch = "ch-alpha";
    expect(coerceBrief({ ...raw, handoff: { kind: "film", film_id: film } })!.handoff).toBeNull();
    expect(coerceBrief({ ...raw, status: "created", handoff: { kind: "film", film_id: film } })!.handoff).toEqual({ kind: "film", filmId: film });
    expect(coerceBrief({ ...raw, status: "created", handoff: { kind: "run", channel_id: ch, job_id: 42 } })!.handoff).toEqual({ kind: "run", channelId: ch, jobId: "42" });
    expect(coerceBrief({ ...raw, status: "created", handoff: { kind: "run", channel_id: ch, dispatched_at: "2026-11-21T00:00:00Z" } })!.handoff).toEqual({
      kind: "run", channelId: ch, dispatchedAt: "2026-11-21T00:00:00Z",
    });
    expect(coerceBrief({ ...raw, status: "created", handoff: { kind: "film", film_id: "../etc" } })!.handoff).toBeNull();
    expect(coerceBrief({ ...raw, status: "created", handoff: { kind: "run", channel_id: ch, job_id: "1; drop" } })!.handoff).toBeNull();
    expect(coerceBrief("nope")).toBeNull();
  });
});

describe("the live route's charge_basis", () => {
  it("is read per take when the route sent it, and is 'not read' (null) when no row carried the column", () => {
    const film = filmJson({ status: "running" }, [sceneJson(S1, 0)]);
    const read = coerceFilmLive({ film, segments: [], takes: [{ id: "t1", error_code: "timeout", charge_basis: "retried_not_charged" }, { id: "t2", charge_basis: null }] })!;
    expect(read.bases?.get("t1")).toBe("retried_not_charged");
    expect(read.bases?.has("t2")).toBe(false);
    expect(coerceFilmLive({ film, segments: [], takes: [{ id: "t1", error_code: "timeout" }] })!.bases).toBeNull();
  });
});
