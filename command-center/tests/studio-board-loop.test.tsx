// @vitest-environment jsdom
/**
 * React H1, pinned where jsdom can see it: LiveView after a handoff committed ~53 times a second in a browser, because each render
 * fed the board a new (but equal) reading and the board answered every one with a new state. What would break without these: a
 * hook that sets state for a reading that changes nothing, and a handoff target made anew on every render.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { coerceTimelineFilm } from "../lib/studio/timeline";
import { filmGraph, type BriefHandoff } from "../lib/studio/liveGraph";
import type { BoardInput } from "../lib/studio/boardModel";
import { useBoardModel } from "../components/studio-live/useBoardModel";
import { useHandoffTarget } from "../components/studio-live/LiveView";
import { S1, S2, filmJson, sceneJson } from "./films-fixtures";

afterEach(cleanup);

/** A new reading object each call, with the same content: what a poll, or a re-render that rebuilds its input, hands the board. */
const reading = (): BoardInput => {
  const f = coerceTimelineFilm({ ...filmJson({ status: "running" }, [sceneJson(S1, 0), sceneJson(S2, 1)]), takes: [] });
  if (!f) throw new Error("fixture did not coerce");
  return { source: "live", graph: filmGraph({ film: f, segments: [], money: new Map(), errors: new Map() }) };
};
const frames = (n: number) =>
  act(async () => {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
  });

describe("useBoardModel: a new but equal reading every render", () => {
  it("keeps the same model and stops re-rendering (no loop)", async () => {
    let renders = 0;
    const { result, rerender } = renderHook(() => {
      renders += 1;
      // A new input object on every render, as LiveView built one when its target was new each render.
      return useBoardModel(reading(), "film:x");
    });
    const first = result.current;
    // One render from outside (a poll, a parent): the old hook answered it with a new state each frame, which rendered again, which
    // made a new reading, for as long as it was mounted.
    rerender();
    const after = renders;
    // Real frames, each with its own act, so every update the hook schedules is rendered before the next frame.
    for (let i = 0; i < 12; i++) await frames(1);
    expect(result.current).toBe(first);
    expect(renders - after).toBeLessThanOrEqual(1);
  });
});

describe("useHandoffTarget", () => {
  it("one target per handoff: a new handoff object with the same fields is the same target", () => {
    const h = (): BriefHandoff => ({ kind: "film", filmId: "0f000000-0000-4000-8000-00000000000f" });
    const { result, rerender } = renderHook(({ handoff }: { handoff: BriefHandoff | null }) => useHandoffTarget(handoff), { initialProps: { handoff: h() as BriefHandoff | null } });
    const first = result.current;
    rerender({ handoff: h() });
    rerender({ handoff: h() });
    expect(result.current).toBe(first);
    rerender({ handoff: { kind: "film", filmId: "0f000000-0000-4000-8000-0000000000ff" } });
    expect(result.current).not.toBe(first);
    rerender({ handoff: null });
    expect(result.current).toBeNull();
  });
});
