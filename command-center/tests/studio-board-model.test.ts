/**
 * The one board from proposal to finished film (lib/studio/boardModel.ts, LIVE_CREATION_PLAN §3.8, §3.10). What would break without
 * these: every scene card re-mounting (and re-animating) at Create because the brief's scene ids are not the film's; the brief's
 * characters, places and props vanishing from the board the moment the film is read; and a re-read with nothing new re-rendering
 * every card.
 */
import { describe, expect, it } from "vitest";
import { coerceTimelineFilm } from "../lib/studio/timeline";
import { coerceBrief, filmGraph, type LiveGraph } from "../lib/studio/liveGraph";
import { reduceBoard, reuseGraph, stageOf } from "../lib/studio/boardModel";
import { S1, S2, filmJson, sceneJson } from "./films-fixtures";

const MP4 = "f1000000-0000-4000-8000-0000000000f1";
function film(status: string, segments: unknown[] = []) {
  const f = coerceTimelineFilm({ ...filmJson({ status }, [sceneJson(S1, 0), sceneJson(S2, 1)]), takes: [] });
  if (!f) throw new Error("fixture did not coerce");
  return filmGraph({ film: f, segments: segments as never, money: new Map(), errors: new Map() });
}
// The conversation's own scene ids ("s1", "s2"): never the film's film_scenes uuids (S1, S2).
const brief = (over: Record<string, unknown> = {}) =>
  coerceBrief({
    status: "ready",
    kind: "short",
    title: "Kite",
    voice: { mode: "off" },
    music: { mode: "off" },
    characters: [{ id: "c1", name: "Aziza" }],
    locations: [{ id: "l1", name: "Rooftop" }],
    scenes: [
      { id: "s1", n: 1, title: "Shot 1", character_ids: ["c1"], location_id: "l1" },
      { id: "s2", n: 2, title: "Shot 2", character_ids: ["c1"] },
    ],
    ...over,
  })!;
const sceneIds = (g: LiveGraph) => g.nodes.filter((n) => n.kind === "keyframe" || n.kind === "clip").map((n) => n.id).sort();

describe("ids across Create", () => {
  it("the same plan read as a brief and then as a film keeps every scene card's id", () => {
    const b = reduceBoard(null, { source: "brief", brief: brief() });
    const f = film("queued");
    expect(sceneIds(b.graph)).toEqual(["scene#1:clip", "scene#1:keyframe", "scene#2:clip", "scene#2:keyframe"]);
    expect(sceneIds(f)).toEqual(sceneIds(b.graph));
    const after = reduceBoard(b, { source: "live", graph: f });
    // Every card on the board before Create is still on it after, under the same id: nothing re-mounts, nothing re-enters.
    const ids = new Set(after.graph.nodes.map((n) => n.id));
    for (const n of b.graph.nodes) expect(ids.has(n.id)).toBe(true);
  });

  it("the brief's character and place cards stay after Create, with the brief's names", () => {
    const b = reduceBoard(null, { source: "brief", brief: brief() });
    const after = reduceBoard(b, { source: "live", graph: film("running") });
    const aziza = after.graph.nodes.find((n) => n.id === "ref:c1");
    expect(aziza).toMatchObject({ kind: "character", sceneTitle: "Aziza" });
    expect(after.graph.nodes.find((n) => n.id === "ref:l1")?.kind).toBe("location");
    // No wires to carry any more (the cast is on the scene's cards, from the scene's own ids): none appear from nowhere.
    expect(after.graph.edges.some((e) => e.from.startsWith("ref:") || e.to.startsWith("ref:"))).toBe(false);
    // And on every later reading of the film.
    const later = reduceBoard(after, { source: "live", graph: film("running") });
    expect(later.graph.nodes.some((n) => n.id === "ref:c1")).toBe(true);
  });
});

describe("identity", () => {
  it("a re-read with nothing new is the same model and the same node objects", () => {
    const a = reduceBoard(null, { source: "live", graph: film("running") });
    const b = reduceBoard(a, { source: "live", graph: film("running") });
    expect(b).toBe(a);
    expect(b.graph.nodes[0]).toBe(a.graph.nodes[0]);
  });
  it("one changed card is a new object; every other card is the one it was", () => {
    const prev = film("running");
    const next: LiveGraph = { ...film("running"), nodes: film("running").nodes.map((n) => (n.id === "scene#1:keyframe" ? { ...n, status: "working" } : n)) };
    const g = reuseGraph(prev, next);
    expect(g).not.toBe(prev);
    for (const n of g.nodes) {
      const old = prev.nodes.find((o) => o.id === n.id)!;
      if (n.id === "scene#1:keyframe") expect(n).not.toBe(old);
      else expect(n).toBe(old);
    }
    expect(g.edges).toBe(prev.edges);
  });
});

describe("stages", () => {
  it("proposing, planning, ready from the brief; making, assembled from the film", () => {
    const drafting = coerceBrief({ status: "drafting", kind: "short" })!;
    expect(reduceBoard(null, { source: "brief", brief: drafting }).stage).toBe("proposing");
    expect(reduceBoard(null, { source: "brief", brief: drafting, writing: true }).stage).toBe("planning");
    expect(reduceBoard(null, { source: "brief", brief: brief() }).stage).toBe("ready");
    expect(reduceBoard(null, { source: "live", graph: film("running") }).stage).toBe("making");
    const done = film("ready", [
      { id: "seg1", status: "completed", assemblyStatus: "completed", assemblyAssetId: MP4, confirmedCredits: null, chargedCredits: null,
        assemblyConfirmedCredits: null, assemblyChargedCredits: null, createdAt: "2026-11-21T00:00:00Z" },
    ]);
    expect(done.nodes.find((n) => n.id === "final")?.status).toBe("done");
    expect(stageOf({ source: "live", graph: done }, done)).toBe("assembled");
  });
});
