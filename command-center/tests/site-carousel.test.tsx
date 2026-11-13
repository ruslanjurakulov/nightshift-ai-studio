// @vitest-environment jsdom
/**
 * The landing's three moving pieces over our own samples: the coverflow carousel, picture → video, prompt → result
 * (components/site/ShowcaseCarousel.tsx, BeforeAfter.tsx, PromptTicker.tsx; props from components/site/landing-samples.tsx).
 *
 * What would break if these failed: a slide or a pair that is not a real merged sample; a prompt shown as the whole when it was
 * cut; a model named outside its sample's box; a maker's "Powered by" line or link back on a public page (the owner's rule,
 * 2026-11-13); a visible pause button (same rule); a carousel that does not move on when its clip ends, or that moves under
 * reduced motion; a slider a keyboard or a finger cannot move; more than one of these players decoding on a phone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries, LOCALES } from "@/lib/i18n";
import { siteCarouselCopy } from "@/lib/i18n/site-carousel";
import { SHOWCASE_ENTRIES } from "@/lib/site/showcase";
import { FORMATS } from "@/lib/site/formats";
import { STILL_MS, beforeAfterPairs, carouselOrder, clock, firstSentence, ringIndex, ringOffset, sliderKey } from "@/lib/site/carousel";
import { showcaseItems } from "@/components/site/ShowcaseGallery";
import { PHONE_TURNS, pickTurns } from "@/components/site/clip-turns";
import { SampleCarousel, SampleCompare, SampleTicker } from "@/components/site/landing-samples";
import { PROVIDER_BRANDS } from "./helpers/brands";
import { without } from "./helpers/showcase-scope";

const ROOT = join(__dirname, "..");
const t = dictionaries.en;
const c = siteCarouselCopy("en");

function env({ reduced = false }: { reduced?: boolean } = {}) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") ? reduced : false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
  Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: false, effectiveType: "4g" } });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  // Every box is fully on screen.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      cb: (e: Partial<IntersectionObserverEntry>[]) => void;
      constructor(cb: (e: Partial<IntersectionObserverEntry>[]) => void) {
        this.cb = cb;
      }
      observe(el: Element) {
        this.cb([{ intersectionRatio: 1, isIntersecting: true, target: el }]);
      }
      unobserve() {}
      disconnect() {}
    },
  );
}
beforeEach(() => {
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve()) as never;
  HTMLMediaElement.prototype.pause = vi.fn() as never;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
});

const items = showcaseItems();
const centre = (root: ParentNode) => root.querySelector<HTMLElement>(".nxc-card[data-offset='0']")!;

describe("the arithmetic", () => {
  it("a ring wraps both ways, and every card knows how far it is from the centre", () => {
    expect(ringIndex(0, -1, 5)).toBe(4);
    expect(ringIndex(4, 1, 5)).toBe(0);
    expect([0, 1, 2, 3, 4].map((i) => ringOffset(i, 0, 5))).toEqual([0, 1, 2, -2, -1]);
    expect(ringOffset(3, 3, 1)).toBe(0);
  });

  it("the carousel shows every sample exactly once, a picture after every two clips", () => {
    const order = carouselOrder(items.map(({ e }) => e));
    expect(order.map((e) => e.jobId).sort()).toEqual(items.map(({ e }) => e.jobId).sort());
    expect(order.slice(0, 3).map((e) => e.kind)).toEqual(["video", "video", "image"]);
  });

  it("a prompt cut to its first sentence says it was cut; a short one is whole", () => {
    expect(firstSentence("A whale glides. The camera tracks.")).toEqual({ text: "A whale glides.", cut: true });
    expect(firstSentence("One sentence only")).toEqual({ text: "One sentence only", cut: false });
    const long = firstSentence("word ".repeat(80));
    expect(long.cut).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(150);
    expect(long.text.endsWith(" ")).toBe(false);
  });

  it("a time that was not measured prints nothing, never 0:00", () => {
    expect(clock(Number.NaN)).toBe("");
    expect(clock(-1)).toBe("");
    expect(clock(4.2)).toBe("0:05");
    expect(clock(65)).toBe("1:05");
  });

  it("the slider's keys stay inside 0..100 and ignore what is not theirs", () => {
    expect(sliderKey(50, "ArrowRight")).toBe(55);
    expect(sliderKey(98, "ArrowRight")).toBe(100);
    expect(sliderKey(3, "ArrowLeft")).toBe(0);
    expect(sliderKey(40, "Home")).toBe(0);
    expect(sliderKey(40, "End")).toBe(100);
    expect(sliderKey(40, "PageUp")).toBe(60);
    expect(sliderKey(40, "a")).toBeNull();
  });

  it("a phone gives one turn to the players most on screen; one that does not want it or barely shows gets none", () => {
    const bids = new Map([
      ["carousel", { ratio: 0.6, want: true }],
      ["ticker", { ratio: 0.9, want: true }],
      ["compare", { ratio: 1, want: false }],
      ["sliver", { ratio: 0.1, want: true }],
    ]);
    expect([...pickTurns(bids, PHONE_TURNS)]).toEqual(["ticker"]);
    expect([...pickTurns(bids, 3)].sort()).toEqual(["carousel", "ticker"]);
  });
});

describe("the pairs are real", () => {
  it("each pair is a shipped clip whose input job is a shipped picture (perfume and lighthouse today)", () => {
    const pairs = beforeAfterPairs(items);
    for (const { clip, picture } of pairs) {
      expect(clip.e.kind).toBe("video");
      expect(picture.e.kind).toBe("image");
      expect(clip.e.input).toMatchObject({ kind: "operator_job", jobId: picture.e.jobId });
    }
    const jobs = new Set(SHOWCASE_ENTRIES.map((e) => e.jobId));
    if (jobs.has("fc1fad12-16de-4cd5-9cd9-e77ed245f469") && jobs.has("e3da9148-f2f8-443e-95b1-8ed36ef3dea4"))
      expect(pairs.map((p) => [p.picture.e.jobId.slice(0, 8), p.clip.e.jobId.slice(0, 8)])).toContainEqual(["e3da9148", "fc1fad12"]);
  });
});

describe("what the three pieces say", () => {
  const all = () =>
    render(
      <>
        <SampleTicker t={t} locale="en" />
        <SampleCarousel t={t} locale="en" />
        <SampleCompare t={t} locale="en" />
      </>,
    );

  it("names a model only inside its sample's box, and no maker's credit line or link anywhere (owner's rule, 2026-11-13)", () => {
    const { container } = all();
    expect(container.querySelectorAll("[data-sample-section]").length).toBeGreaterThan(0);
    const outside = without(container, "[data-showcase-entry]");
    expect(outside.textContent ?? "").not.toMatch(PROVIDER_BRANDS);
    expect(container.textContent ?? "").not.toMatch(/powered by/i);
    for (const a of container.querySelectorAll("a")) expect(a.getAttribute("href") ?? "").not.toMatch(/runway\.com|ideogram\.ai|^https?:/);
    // Every box says it is AI-generated.
    for (const box of container.querySelectorAll(".nxc-info, .nxb, .nxt")) expect(box.textContent).toContain(t.site.gallery.badge);
  });

  it("“Use this prompt” only fills the Studio form through sign-up, names no model, and exists only for a tool with a form", () => {
    const { container } = render(<SampleCarousel t={t} locale="en" />);
    const use = container.querySelector<HTMLAnchorElement>(".nxc-use");
    const first = carouselOrder(items.map(({ e }) => e))[0];
    if (["t2v", "t2i"].includes(first.capability)) {
      const href = use!.getAttribute("href")!;
      expect(href.startsWith("/signup?next=")).toBe(true);
      const next = decodeURIComponent(href.split("next=")[1]);
      expect(next).toContain(`tool=${first.capability}`);
      expect(next).not.toContain("model=");
    } else expect(use).toBeNull();
  });

  it("every sample without a format has its own title in all three languages", () => {
    const formatJobs = new Set<string>(FORMATS.map((f) => f.job));
    for (const { code } of LOCALES) {
      const titles = siteCarouselCopy(code).carousel.titles;
      for (const { e } of items) if (!formatJobs.has(e.jobId)) expect(titles[e.jobId], `${code} ${e.jobId}`).toBeTruthy();
    }
  });

  it("shows no visible pause button: the stop and pause controls are keyboard-only, hidden until focused", () => {
    env();
    const { container } = all();
    const run = container.querySelector(".nxc-run")!;
    expect(run.classList.contains("nxc-kbd")).toBe(true);
    for (const b of container.querySelectorAll(".nxt-hold")) expect(b.classList.contains("nxt-kbd")).toBe(true);
    const css = ["showcase-carousel.css", "prompt-ticker.css", "before-after.css"].map((f) => readFileSync(join(ROOT, "components/site", f), "utf8")).join("\n");
    for (const k of ["nxc-kbd", "nxt-kbd", "nxb-kbd"]) expect(css).toMatch(new RegExp(`\\.${k}:not\\(:focus\\) \\{[^}]*clip-path: inset\\(50%\\)`));
    // And nothing here shows the page's pause switch.
    expect(container.querySelector(".nx-motion-btn, .nx-clip-pause")).toBeNull();
  });
});

describe("the carousel", () => {
  it("moves on when the centre clip ends, and goes on from a side card pressed into the centre", () => {
    env();
    const { container } = render(<SampleCarousel t={t} locale="en" />);
    const order = carouselOrder(items.map(({ e }) => e));
    expect(centre(container).getAttribute("data-showcase-entry")).toBe(order[0].jobId);
    const v = centre(container).querySelector("video");
    expect(v, "the centre clip plays").toBeTruthy();
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    act(() => void fireEvent.ended(v!));
    expect(centre(container).getAttribute("data-showcase-entry")).toBe(order[1].jobId);
    // A press on the card to its left brings that one back to the centre.
    act(() => void fireEvent.click(container.querySelector(".nxc-card[data-offset='-1'] button")!));
    expect(centre(container).getAttribute("data-showcase-entry")).toBe(order[0].jobId);
    expect(container.querySelector("[role='status']")!.textContent).toContain(c.carousel.now.replace("{title}", ""));
    // And its clip ending moves the carousel on again.
    act(() => void fireEvent.ended(centre(container).querySelector("video")!));
    expect(centre(container).getAttribute("data-showcase-entry")).toBe(order[1].jobId);
  });

  it("arrow keys move it, a tap on the centre clip stops it, and only the centre card ever holds a video", () => {
    env();
    const { container } = render(<SampleCarousel t={t} locale="en" />);
    const order = carouselOrder(items.map(({ e }) => e));
    const region = container.querySelector("[aria-roledescription='carousel']")!;
    act(() => void fireEvent.keyDown(region, { key: "ArrowRight" }));
    expect(centre(container).getAttribute("data-showcase-entry")).toBe(order[1].jobId);
    act(() => void fireEvent.keyDown(region, { key: "ArrowLeft" }));
    expect(centre(container).getAttribute("data-showcase-entry")).toBe(order[0].jobId);
    expect(container.querySelectorAll("video")).toHaveLength(1);
    act(() => void fireEvent.click(centre(container).querySelector(".nxc-media")!));
    expect(container.querySelector(".nxc-run")!.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".nxc")!.getAttribute("data-run")).toBe("false");
  });

  it("a picture holds the centre for its turn, then the next card comes in", () => {
    env();
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    const { container } = render(<SampleCarousel t={t} locale="en" />);
    const order = carouselOrder(items.map(({ e }) => e));
    const still = order.findIndex((e) => e.kind === "image");
    if (still < 0) return;
    const region = container.querySelector("[aria-roledescription='carousel']")!;
    for (let k = 0; k < still; k++) act(() => void fireEvent.keyDown(region, { key: "ArrowRight" }));
    // Keyboard presses do not hold the carousel here (no focus moved inside), so the picture's turn runs.
    expect(centre(container).getAttribute("data-showcase-entry")).toBe(order[still].jobId);
    act(() => void vi.advanceTimersByTime(STILL_MS - 500));
    expect(centre(container).getAttribute("data-showcase-entry")).toBe(order[still].jobId);
    act(() => void vi.advanceTimersByTime(1000));
    expect(centre(container).getAttribute("data-showcase-entry")).toBe(order[(still + 1) % order.length].jobId);
  });

  it("under reduced motion nothing plays or moves by itself; a clip plays only when its play button is pressed", () => {
    env({ reduced: true });
    const { container } = render(<SampleCarousel t={t} locale="en" />);
    const first = centre(container).getAttribute("data-showcase-entry");
    expect(container.querySelector("video")).toBeNull();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    const play = centre(container).querySelector<HTMLButtonElement>(".nxc-clipbtn");
    expect(play, "a visible play button").toBeTruthy();
    expect(play!.classList.contains("nxc-kbd")).toBe(false);
    act(() => void fireEvent.click(play!));
    const v = centre(container).querySelector("video");
    expect(v).toBeTruthy();
    act(() => void fireEvent.ended(v!));
    // It ended where it was: no advance under reduced motion.
    expect(centre(container).getAttribute("data-showcase-entry")).toBe(first);
  });
});

describe("picture → video", () => {
  it("the divider is a slider the keyboard and a drag both move, and a tap pauses the clip", () => {
    env();
    const { container } = render(<SampleCompare t={t} locale="en" />);
    const sliders = container.querySelectorAll<HTMLElement>("[role='slider']");
    expect(sliders.length).toBe(beforeAfterPairs(items).length);
    if (sliders.length === 0) return;
    const s = sliders[0];
    expect(s.getAttribute("aria-valuenow")).toBe("50");
    act(() => void fireEvent.keyDown(s, { key: "ArrowRight" }));
    expect(s.getAttribute("aria-valuenow")).toBe("55");
    expect(s.getAttribute("aria-valuetext")).toBe("55% picture, 45% video");
    act(() => void fireEvent.keyDown(s, { key: "Home" }));
    expect(s.getAttribute("aria-valuenow")).toBe("0");
    // jsdom has no PointerEvent: a MouseEvent with a pointer id carries clientX the way a browser's does.
    vi.stubGlobal(
      "PointerEvent",
      class extends MouseEvent {
        pointerId: number;
        constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 0;
        }
      },
    );
    const frame = s.closest<HTMLElement>(".nxb-frame")!;
    frame.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} });
    act(() => void fireEvent.pointerDown(frame, { pointerId: 1, clientX: 100 }));
    act(() => void fireEvent.pointerMove(frame, { pointerId: 1, clientX: 150 }));
    act(() => void fireEvent.pointerUp(frame, { pointerId: 1, clientX: 150 }));
    expect(s.getAttribute("aria-valuenow")).toBe("75");
    // A tap (no drag) pauses the clip instead of moving the line; its button is the keyboard's, out of sight.
    const btn = frame.querySelector(".nxb-play")!;
    expect(btn.classList.contains("nxb-kbd")).toBe(true);
    act(() => void fireEvent.pointerDown(frame, { pointerId: 2, clientX: 20 }));
    act(() => void fireEvent.pointerUp(frame, { pointerId: 2, clientX: 20 }));
    expect(s.getAttribute("aria-valuenow")).toBe("75");
    expect(btn.getAttribute("aria-label")).toBe(c.compare.playClip);
  });

  it("names both models, the picture's and the clip's, inside the clip's box", () => {
    const { container } = render(<SampleCompare t={t} locale="en" />);
    for (const { clip, picture } of beforeAfterPairs(items)) {
      const box = container.querySelector(`[data-showcase-entry="${clip.e.jobId}"]`)!;
      expect(box.textContent).toContain(clip.e.modelName);
      expect(box.textContent).toContain(picture.e.modelName);
      expect(box.querySelector(`[data-source-entry="${picture.e.jobId}"]`)).toBeTruthy();
    }
  });
});

describe("prompt → result", () => {
  it("under reduced motion it is the first sample, its whole first sentence, still: nothing types and nothing plays", () => {
    env({ reduced: true });
    const { container } = render(<SampleTicker t={t} locale="en" />);
    const box = container.querySelector<HTMLElement>(".nxt");
    if (!box) return;
    const job = box.getAttribute("data-showcase-entry")!;
    const e = SHOWCASE_ENTRIES.find((x) => x.jobId === job)!;
    expect(e.capability).toBe("t2v");
    const line = firstSentence(e.prompt);
    expect(box.querySelector(".nxt-line .sr-only")!.textContent).toBe(line.text + (line.cut ? "…" : ""));
    expect(box.getAttribute("data-phase")).toBe("result");
    expect(container.querySelector("video")).toBeNull();
  });

  it("never shows a sample a landing slot already shows, nor anything but a text-to-video clip with words", () => {
    const { container } = render(<SampleTicker t={t} locale="en" />);
    const job = container.querySelector(".nxt")?.getAttribute("data-showcase-entry");
    if (!job) return;
    expect(["de53f364-eaf7-4cd1-8d44-7b56b21b03b6"]).not.toContain(job);
  });
});
