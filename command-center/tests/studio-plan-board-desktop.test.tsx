// @vitest-environment jsdom
/**
 * The Plan column's storyboard at a desk (components/studio-live/PlanBoard.tsx), which the phone-width tests never draw. What would
 * break without these: a card reached by Tab but left off screen, a focus that pans sideways or zooms (Pixel N1), the controls
 * missing or unnamed, and a card running under the controls (Pixel b).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { coerceBrief, briefGraph } from "../lib/studio/liveGraph";
import { planItems } from "../lib/studio/planGrid";
import { studioLiveEn as c } from "../lib/i18n/studio-live/en";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
const { PlanBoard, planCards, scrollInto, CONTROLS_GUTTER } = await import("../components/studio-live/PlanBoard");
const { en } = await import("../lib/i18n/en");

const W = 936;
const H = 600;
const items = planItems(
  briefGraph(
    coerceBrief({
      status: "ready",
      kind: "short",
      voice: { mode: "off" },
      music: { mode: "off" },
      scenes: Array.from({ length: 30 }, (_, i) => ({ id: `s${i + 1}`, n: i + 1, title: `Shot ${i + 1}` })),
    })!,
  ),
);
beforeEach(() => {
  // A desk: the board is measured (jsdom has no layout), motion reduced so a move lands at once.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  for (const k of ["clientWidth", "clientHeight"] as const) {
    Object.defineProperty(HTMLElement.prototype, k, {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("plan-board") ? (k === "clientWidth" ? W : H) : 0;
      },
    });
  }
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Back to Element.prototype's own getters (jsdom defines them there, not on HTMLElement).
  for (const k of ["clientWidth", "clientHeight"] as const) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
});

const transform = () => (document.querySelector(".react-flow__viewport") as HTMLElement).style.transform;

describe("PlanBoard at a desk", () => {
  it("draws every card (never only the visible ones), with React Flow's controls named in the app's words", () => {
    render(<PlanBoard cards={planCards(en, items, { selected: null, onOpen: () => {}, enter: new Map() })} items={items} />);
    expect(screen.getByTestId("plan-card-scene#30")).toBeTruthy();
    expect(document.querySelectorAll("[data-node-id]")).toHaveLength(items.top.length + items.scenes.length + items.footer.length);
    const controls = document.querySelector(".react-flow__controls")!;
    expect(controls.getAttribute("aria-label")).toBe(c.plan.controls.label);
    expect(controls.querySelector(`[aria-label="${c.plan.controls.fit}"]`)).not.toBeNull();
  });

  it("focusing a card below the fold scrolls the board down to it: y only, the same x and zoom", async () => {
    render(<PlanBoard cards={planCards(en, items, { selected: null, onOpen: () => {}, enter: new Map() })} items={items} />);
    expect(transform().replace(/\s/g, "")).toBe("translate(0px,0px)scale(1)");
    await act(async () => {
      screen.getByTestId("plan-card-scene#30").focus();
      await new Promise((r) => setTimeout(r, 30));
    });
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([\d.]+)\)/.exec(transform())!;
    expect(Number(m[1])).toBe(0);
    expect(Number(m[2])).toBeLessThan(0);
    expect(Number(m[3])).toBe(1);
  });

  it("no card is placed under the controls: the grid keeps their gutter at the right", () => {
    render(<PlanBoard cards={planCards(en, items, { selected: null, onOpen: () => {}, enter: new Map() })} items={items} />);
    const right = Math.max(
      ...[...document.querySelectorAll<HTMLElement>(".react-flow__node")].map((n) => {
        const x = Number(/translate\(([-\d.]+)px/.exec(n.style.transform)![1]);
        return x + parseFloat((n.querySelector(".plan-node") as HTMLElement).style.width);
      }),
    );
    expect(right).toBeLessThanOrEqual(W - CONTROLS_GUTTER);
  });
});

describe("scrollInto", () => {
  it("moves as little as brings the card in, and not at all when it is in", () => {
    expect(scrollInto(100, 50, 600, 0)).toBe(0);
    expect(scrollInto(700, 100, 600, 0)).toBe(-(700 + 100 - 588));
    expect(scrollInto(50, 100, 600, -200)).toBe(-200 + (12 - (50 - 200)));
  });
});
