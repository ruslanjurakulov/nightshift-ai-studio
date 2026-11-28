// @vitest-environment jsdom
/**
 * When a canvas card may celebrate (components/studio-canvas/parts.tsx useJustFinished, FinishRing). The board-level path
 * is pinned in studio-canvas-ui.test.tsx; these pin the edges Lens found on #968:
 * - a ring beside "the result is loading" or "can't be shown" (the card says the result is not there, rule 5);
 * - a ring for a job first read as done (nothing finished in front of anyone);
 * - a ring after a failure, or one that never clears;
 * - the phone card's ring, which had no test, and the selection mark the ring must not replace.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { FinishRing, JUST_FINISHED_MS, useJustFinished } from "@/components/studio-canvas/parts";
import type { NodeStatus } from "@/components/studio-canvas/nodeState";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function run(steps: Array<[NodeStatus, boolean]>) {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(({ s, r }: { s: NodeStatus; r: boolean }) => useJustFinished(s, r), {
    initialProps: { s: steps[0][0], r: steps[0][1] },
  });
  const seen: boolean[] = [result.current];
  for (const [s, r] of steps.slice(1)) {
    rerender({ s, r });
    seen.push(result.current);
  }
  return { result, seen };
}

describe("useJustFinished", () => {
  it("rings when a watched run ends with its result in view, then stops", () => {
    const { result, seen } = run([
      ["working", true],
      ["done", true],
    ]);
    expect(seen).toEqual([false, true]);
    act(() => vi.advanceTimersByTime(JUST_FINISHED_MS + 1));
    expect(result.current).toBe(false);
  });

  it("waits for the result: done while the picture is still loading rings only once it shows", () => {
    const { seen } = run([
      ["working", true],
      ["done", false],
      ["done", false],
      ["done", true],
    ]);
    expect(seen).toEqual([false, false, false, true]);
  });

  it("never rings for a result that cannot be shown", () => {
    const { seen } = run([
      ["queued", true],
      ["done", false],
    ]);
    expect(seen).toEqual([false, false]);
  });

  it("does not celebrate a job first read as done, or a failure", () => {
    expect(run([["done", true]]).seen).toEqual([false]);
    expect(
      run([
        ["loading", true],
        ["done", true],
      ]).seen,
    ).toEqual([false, false]);
    expect(
      run([
        ["working", true],
        ["failed", true],
        ["done", true],
      ]).seen,
    ).toEqual([false, false, false]);
  });

  it("rings once per run: a second render of the same finish does not replay it", () => {
    const { result } = run([
      ["working", true],
      ["done", true],
    ]);
    act(() => vi.advanceTimersByTime(JUST_FINISHED_MS + 1));
    expect(result.current).toBe(false);
  });
});

describe("FinishRing (the phone card)", () => {
  it("draws its decoration only for the moment, inside the card", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<FinishRing status="working" ready />);
    expect(container.querySelector("[data-fx=finish]")).toBeNull();
    rerender(<FinishRing status="done" ready />);
    expect(container.querySelector("[data-fx=finish]")?.getAttribute("aria-hidden")).toBe("true");
    act(() => vi.advanceTimersByTime(JUST_FINISHED_MS + 1));
    expect(container.querySelector("[data-fx=finish]")).toBeNull();
  });
});

describe("the finish ring and a person's selection", () => {
  const css = readFileSync(path.join(process.cwd(), "components/studio-canvas/studio-canvas.css"), "utf8");

  it("never replaces the selection mark: a selected card keeps its amber ring and gets the success ring outside it", () => {
    expect(css).toMatch(/\.cv-node\.is-just-done:not\(\.is-sel\) \{/);
    expect(css).toMatch(/\.cv-node\.is-sel\.is-just-done \{ box-shadow: 0 0 0 1px var\(--amber\), 0 0 0 6px var\(--amber-soft\), 0 0 0 9px/);
    expect(css).not.toMatch(/^\.cv-node\.is-just-done \{/m);
  });

  it("is inset on the phone card, which clips its overflow", () => {
    expect(css).toMatch(/\.cv-finish \{[^}]*box-shadow: inset 0 0 0 2px var\(--ds-success\)/);
  });
});
