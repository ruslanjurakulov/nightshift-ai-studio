/**
 * The Plan column's rules (lib/studio/planBoard.ts). What would break without these: a refresh replaying the whole plan's entrance, a
 * storyboard's cards arriving out of scene order, the person's "My canvas" choice lost on their next message (or kept into a new
 * conversation, hiding its plan), and a wide plan fitted from its middle so its first steps are off the board.
 */
import { describe, expect, it } from "vitest";
import { coerceBrief, briefGraph } from "../lib/studio/liveGraph";
import {
  adoptSession,
  ENTER_CAP,
  enteringCards,
  initialView,
  parseViewMemory,
  planViewport,
  viewOnSend,
} from "../lib/studio/planBoard";

const A = "5e550000-0000-4000-8000-0000000000e1";
const B = "5e550000-0000-4000-8000-0000000000e2";
const drafting = briefGraph(coerceBrief({ status: "drafting", kind: "short", voice: { mode: "off" }, music: { mode: "off" } })!);
const scenes = (n: number) =>
  briefGraph(
    coerceBrief({
      status: "ready",
      kind: "short",
      title: "Kite",
      voice: { mode: "off" },
      music: { mode: "off" },
      scenes: Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, n: i + 1, title: `Shot ${i + 1}` })),
    })!,
  );

describe("enteringCards", () => {
  it("the first reading after a load or refresh enters nothing", () => {
    expect(enteringCards(null, scenes(4)).size).toBe(0);
  });
  it("a column that opened empty: every card of the first plan enters", () => {
    expect(enteringCards(new Set(), drafting).size).toBe(drafting.nodes.length);
  });
  it("only the cards new since the last reading enter, scene by scene, picture before clip", () => {
    const seen = new Set(drafting.nodes.map((n) => n.id));
    const e = enteringCards(seen, scenes(3));
    expect([...e.keys()]).toEqual(["scene#1:keyframe", "scene#1:clip", "scene#2:keyframe", "scene#2:clip", "scene#3:keyframe", "scene#3:clip"]);
    expect([...e.values()]).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it("the same plan read again enters nothing", () => {
    const g = scenes(3);
    expect(enteringCards(new Set(g.nodes.map((n) => n.id)), scenes(3)).size).toBe(0);
  });
  it("a long storyboard's tail arrives together instead of taking seconds", () => {
    const e = enteringCards(new Set(drafting.nodes.map((n) => n.id)), scenes(40));
    expect(Math.max(...e.values())).toBe(ENTER_CAP);
  });
});

describe("the switch's memory", () => {
  it("sending shows the plan, even when nothing was chosen before", () => {
    expect(viewOnSend(null, null)).toBe("plan");
    expect(viewOnSend(null, A)).toBe("plan");
  });
  it("'My canvas' chosen in this conversation holds for its next messages", () => {
    expect(viewOnSend({ session: A, view: "canvas" }, A)).toBe("canvas");
  });
  it("a new conversation shows the plan again", () => {
    expect(viewOnSend({ session: A, view: "canvas" }, null)).toBe("plan");
    expect(viewOnSend({ session: A, view: "canvas" }, B)).toBe("plan");
  });
  it("a choice made during the first turn belongs to the conversation it started", () => {
    const m = adoptSession({ session: null, view: "canvas" }, A);
    expect(m).toEqual({ session: A, view: "canvas" });
    expect(viewOnSend(m, A)).toBe("canvas");
    const kept = { session: B, view: "canvas" as const };
    expect(adoptSession(kept, A)).toBe(kept);
  });
  it("on open: the stored choice for this conversation, else the plan when there is one, else the canvas", () => {
    expect(initialView({ session: A, view: "canvas" }, A)).toBe("canvas");
    expect(initialView({ session: B, view: "canvas" }, A)).toBe("plan");
    expect(initialView(null, null)).toBe("canvas");
  });
  it("stored values that cannot be trusted are no choice", () => {
    for (const raw of [null, "", "{", "[]", '{"view":"plan"}', '{"session":"x","view":"plan"}', `{"session":"${A}","view":"board"}`])
      expect(parseViewMemory(raw)).toBeNull();
    expect(parseViewMemory(`{"session":"${A}","view":"canvas"}`)).toEqual({ session: A, view: "canvas" });
    expect(parseViewMemory('{"session":null,"view":"plan"}')).toEqual({ session: null, view: "plan" });
  });
});

describe("planViewport", () => {
  it("a plan that fits is centred", () => {
    const v = planViewport({ x: 0, y: 0, width: 400, height: 200 }, 1000, 600)!;
    expect(v.zoom).toBe(1);
    expect(v.x).toBe(300);
    expect(v.y).toBe(200);
  });
  it("a plan wider than the board starts at its first card, at a readable zoom", () => {
    const v = planViewport({ x: 0, y: -124, width: 1616, height: 500 }, 900, 600)!;
    expect(v.zoom).toBe(0.72);
    expect(v.x).toBe(24);
  });
  it("nothing measured: no move", () => {
    expect(planViewport({ x: 0, y: 0, width: 0, height: 0 }, 900, 600)).toBeNull();
    expect(planViewport({ x: 0, y: 0, width: 100, height: 100 }, 0, 0)).toBeNull();
  });
});
