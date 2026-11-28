/**
 * The Plan column's rules (lib/studio/planBoard.ts). What would break without these: a refresh replaying the whole plan's entrance, a
 * storyboard's cards arriving out of scene order, the person's "My canvas" choice lost on their next message (or kept into a new
 * conversation, hiding its plan), and a wide plan fitted from its middle so its first steps are off the board.
 */
import { describe, expect, it } from "vitest";
import { coerceBrief, briefGraph } from "../lib/studio/liveGraph";
import { cardState, planItems, planLayout } from "../lib/studio/planGrid";
import {
  adoptSession,
  ENTER_CAP,
  enteringIds,
  initialView,
  parseViewMemory,
  viewOnSend,
} from "../lib/studio/planBoard";

const A = "5e550000-0000-4000-8000-0000000000e1";
const B = "5e550000-0000-4000-8000-0000000000e2";
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

describe("enteringIds", () => {
  const ids = ["idea", "script", "ref:c1", "scene#1", "scene#2", "scene#3", "assembly", "final"];
  it("the first reading after a load or refresh enters nothing", () => {
    expect(enteringIds(null, ids).size).toBe(0);
  });
  it("a column that opened empty: every card of the first plan enters, in reading order", () => {
    expect([...enteringIds(new Set(), ids).keys()]).toEqual(ids);
  });
  it("only the cards new since the last reading enter, each with its place among them", () => {
    const e = enteringIds(new Set(["idea", "script", "assembly", "final"]), ids);
    expect([...e.entries()]).toEqual([["ref:c1", 0], ["scene#1", 1], ["scene#2", 2], ["scene#3", 3]]);
  });
  it("the same plan read again enters nothing", () => {
    expect(enteringIds(new Set(ids), ids).size).toBe(0);
  });
  it("a long storyboard's tail arrives together instead of taking seconds", () => {
    const many = Array.from({ length: 40 }, (_, i) => `scene#${i + 1}`);
    expect(Math.max(...enteringIds(new Set(), many).values())).toBe(ENTER_CAP);
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

describe("the storyboard grid (lib/studio/planGrid.ts)", () => {
  const items = (n: number) => planItems(scenes(n));
  it("a scene's picture and clip fold into one scene card that keeps the steps' position-keyed ids", () => {
    const it2 = items(2);
    expect(it2.scenes.map((s) => s.id)).toEqual(["scene#1", "scene#2"]);
    expect(it2.scenes[0].keyframe.id).toBe("scene#1:keyframe");
    expect(it2.scenes[0].clip?.id).toBe("scene#1:clip");
    expect(it2.top.map((n) => n.id)).toEqual(["idea", "script"]);
    expect(it2.footer.map((n) => n.id)).toEqual(["assembly", "final"]);
    // Voice off and no music: said in one line, not drawn as cards.
    expect(it2.absent.sort()).toEqual(["music", "voice"]);
  });
  it("12 scenes fit at zoom 1 in the 1440 px column (a 936 x 600 board), one card per scene, never shrunk", () => {
    const l = planLayout(items(12), 936);
    expect(l.cols).toBeGreaterThanOrEqual(4);
    expect(l.cardW).toBeGreaterThanOrEqual(200);
    expect(l.width).toBeLessThanOrEqual(936);
    expect(l.height).toBeLessThanOrEqual(600);
  });
  it("more scenes wrap into more rows (the board scrolls down), the card width never drops below its minimum", () => {
    const l = planLayout(items(40), 936);
    expect(l.cardW).toBeGreaterThanOrEqual(200);
    expect(l.height).toBeGreaterThan(600);
    const ys = new Set(l.placed.filter((p) => p.id.startsWith("scene#")).map((p) => p.y));
    expect(ys.size).toBe(Math.ceil(40 / l.cols));
  });
  it("a taller card (a measured height) makes its whole row taller: nothing overlaps the row below", () => {
    const base = planLayout(items(8), 936);
    const tall = planLayout(items(8), 936, new Map([["scene#2", 200]]));
    const y = (l: typeof base, id: string) => l.placed.find((p) => p.id === id)!.y;
    expect(y(tall, "scene#5") - y(base, "scene#5")).toBe(200 - 116);
  });
  it("a phone-width board: one column", () => {
    expect(planLayout(items(3), 360).cols).toBe(1);
  });
});

describe("cardState (S5's LiveNode states)", () => {
  it("maps each status, and a done step with no file is unknown, not queued (rule 5)", () => {
    expect(cardState({ status: "draft" })).toBe("ghost");
    expect(cardState({ status: "waiting" })).toBe("queued");
    expect(cardState({ status: "working" })).toBe("working");
    expect(cardState({ status: "done", assetId: "a" })).toBe("arrived");
    expect(cardState({ status: "done", assetId: null })).toBe("unknown");
    expect(cardState({ status: "failed" })).toBe("failed");
    expect(cardState({ status: "skipped" })).toBe("disabled");
    expect(cardState({ status: "stopped" })).toBe("disabled");
    expect(cardState({ status: "unknown" })).toBe("unknown");
  });
});
