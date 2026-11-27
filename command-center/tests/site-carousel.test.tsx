// @vitest-environment jsdom
/**
 * The landing's three moving pieces over our own samples: the coverflow carousel, picture → video, prompt → result
 * (components/site/ShowcaseCarousel.tsx, BeforeAfter.tsx, PromptTicker.tsx; props from components/site/landing-samples.tsx).
 *
 * What would break if these failed: a slide or a pair that is not a real merged sample; a prompt shown as the whole when it was
 * cut; a model named outside its sample's box; a maker's "Powered by" line or link back on a public page (the owner's rule,
 * 2026-11-13); a visible pause button (same rule); a carousel that does not move on when its clip ends, or that moves under
 * reduced motion; a slider a keyboard or a finger cannot move; a player on screen that holds a still while another plays.
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
import { showcaseItems, showcaseItemsWithSources } from "@/components/site/ShowcaseGallery";
import { PHONE_TURNS, SHOW_RATIO, WIDE_TURNS, pickTurns, shownRatio } from "@/components/site/clip-turns";
import { SampleCarousel, SampleCompare, SampleTicker, effectPreviewJobs, landingGalleryJobs, sampleSectionJobs } from "@/components/site/landing-samples";
import { LANDING_LEFT_OUT, landingExcludedJobs } from "@/components/site/slots";
import { TOOL_JOBS } from "@/lib/site/tool-samples";
import { holdClips } from "@/lib/site/clip-hold";
import { setMotionPaused, useMotionPaused } from "@/lib/site/motion";
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
// What the landing leaves out of every sample section (landingExcludedJobs: its places and the owner's left-out samples), and the
// carousel's own order after picture → video and the ticker have taken theirs.
const SLOT_JOBS = landingExcludedJobs();
const shown = items.filter(({ e }) => !SLOT_JOBS.includes(e.jobId));
// Picture → video shows a starting frame beside its clip (the grids leave it out: Atlas/owner decision 22 Nov, a starting frame is
// not its own sample), so the pairs are built from every entry, frames included.
const withSources = showcaseItemsWithSources();
const shownPairs = withSources.filter(({ e }) => !SLOT_JOBS.includes(e.jobId));
const carouselJobs = () => {
  // The carousel takes what the other landing surfaces leave: picture → video, the ticker, the explore grid's share and the
  // Effects section's previews (components/site/landing-samples.tsx landingSplit).
  const elsewhere = [...SLOT_JOBS, ...sampleSectionJobs(SLOT_JOBS), ...landingGalleryJobs(SLOT_JOBS), ...effectPreviewJobs()];
  return carouselOrder(items.filter(({ e }) => !elsewhere.includes(e.jobId)).map(({ e }) => e));
};
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

  // What would break (the owner's report of 2026-11-14): a phone gave ONE turn, so a second clip on screen held a still and read
  // as frozen. Every clip that shows 35% of itself and wants to play gets one; one that does not want it or barely shows does not.
  it("every player on screen gets a turn, on a phone too; one that does not want it or shows less than 35% gets none", () => {
    const bids = new Map([
      ["carousel", { ratio: 0.6, want: true }],
      ["ticker", { ratio: 0.9, want: true }],
      ["grid", { ratio: 0.35, want: true }],
      ["compare", { ratio: 1, want: false }],
      ["sliver", { ratio: 0.3, want: true }],
    ]);
    expect([...pickTurns(bids, PHONE_TURNS)].sort()).toEqual(["carousel", "grid", "ticker"]);
  });

  // What would break: a cap below what one screen shows leaves a visible clip stopped while its neighbour plays. The densest landing
  // screens measured 3 clips at once at 390 x 844 and 6 at 1440 x 900 (the model grid); when a cap does bind, the clips most on
  // screen are the ones that play, never one at the edge over one in the middle.
  it("the caps cover the densest screen measured, and past a cap the clips most on screen play", () => {
    expect(PHONE_TURNS).toBeGreaterThanOrEqual(3);
    expect(WIDE_TURNS).toBeGreaterThanOrEqual(6);
    const bids = new Map([
      ["edge", { ratio: 0.4, want: true }],
      ["middle", { ratio: 1, want: true }],
      ["most", { ratio: 0.8, want: true }],
    ]);
    expect([...pickTurns(bids, 2)].sort()).toEqual(["middle", "most"]);
  });

  // What would break: a clip taller than the screen (a bleed behind a first screen) can never show 35% of itself, so by its own
  // share it would never play although it fills the screen.
  it("a clip taller than the screen counts by how much of the screen it fills", () => {
    const rect = (width: number, height: number) => ({ width, height }) as DOMRectReadOnly;
    expect(shownRatio({ intersectionRatio: 0.25, isIntersecting: true, intersectionRect: rect(390, 844), rootBounds: rect(390, 844) })).toBe(1);
    expect(shownRatio({ intersectionRatio: 0.1, isIntersecting: true, intersectionRect: rect(390, 100), rootBounds: rect(390, 844) })).toBeLessThan(SHOW_RATIO);
    // A test double or an old engine with no ratio: in view counts as whole, out of view as none.
    expect(shownRatio({ isIntersecting: true } as IntersectionObserverEntry)).toBe(1);
    expect(shownRatio({ isIntersecting: false } as IntersectionObserverEntry)).toBe(0);
  });
});

describe("the pairs are real", () => {
  it("each pair is a shipped clip whose input is a shipped picture's own output: its job and its library asset", () => {
    const pairs = beforeAfterPairs(withSources);
    for (const { clip, picture } of pairs) {
      expect(clip.e.kind).toBe("video");
      expect(picture.e.kind).toBe("image");
      expect(clip.e.input).toEqual({ kind: "operator_job", jobId: picture.e.jobId, assetId: picture.e.assetId });
    }
    // A picture that only shares the job, not the asset the clip was made from, is not its source.
    if (pairs.length > 0) {
      const { clip, picture } = pairs[0];
      const other = { ...picture, e: { ...picture.e, assetId: "00000000-0000-4000-8000-000000000000" } };
      expect(beforeAfterPairs([clip, other])).toEqual([]);
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
    const first = carouselJobs()[0];
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
    // :focus-visible, not :focus: a mouse press focuses a button too, and must never leave a visible Pause behind it.
    for (const k of ["nxc-kbd", "nxt-kbd", "nxb-kbd"]) expect(css).toMatch(new RegExp(`\\.${k}:not\\(:focus-visible\\) \\{[^}]*clip-path: inset\\(50%\\)`));
    expect(css).not.toMatch(/:not\(:focus\)/);
    // And nothing here shows the page's pause switch.
    expect(container.querySelector(".nx-motion-btn, .nx-clip-pause")).toBeNull();
  });
});

describe("the carousel", () => {
  it("moves on when the centre clip ends, and goes on from a side card pressed into the centre", () => {
    env();
    const { container } = render(<SampleCarousel t={t} locale="en" />);
    const order = carouselJobs();
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
    const order = carouselJobs();
    const region = container.querySelector("[aria-roledescription='carousel']")!;
    act(() => void fireEvent.keyDown(region, { key: "ArrowRight" }));
    expect(centre(container).getAttribute("data-showcase-entry")).toBe(order[1].jobId);
    act(() => void fireEvent.keyDown(region, { key: "ArrowLeft" }));
    expect(centre(container).getAttribute("data-showcase-entry")).toBe(order[0].jobId);
    expect(container.querySelectorAll("video")).toHaveLength(1);
    const run = container.querySelector(".nxc-run")!;
    act(() => void fireEvent.click(centre(container).querySelector(".nxc-media")!));
    expect(run.getAttribute("aria-pressed")).toBe("true");
    // A toggle keeps one name; only aria-pressed says its state.
    expect(run.getAttribute("aria-label")).toBe(c.carousel.pause);
    expect(container.querySelector(".nxc")!.getAttribute("data-run")).toBe("false");
    act(() => void fireEvent.click(centre(container).querySelector(".nxc-media")!));
    expect(run.getAttribute("aria-pressed")).toBe("false");
    expect(run.getAttribute("aria-label")).toBe(c.carousel.pause);
  });

  it("starting it while the page's pause switch is on runs this carousel only: the page's switch stays on", () => {
    env();
    let page = false;
    function Probe() {
      page = useMotionPaused();
      return null;
    }
    const { container } = render(
      <>
        <Probe />
        <SampleCarousel t={t} locale="en" />
      </>,
    );
    act(() => setMotionPaused(true));
    const run = container.querySelector(".nxc-run")!;
    expect(run.getAttribute("aria-pressed")).toBe("true");
    act(() => void fireEvent.click(run));
    expect(run.getAttribute("aria-pressed")).toBe("false");
    expect(page).toBe(true);
    expect(document.documentElement.getAttribute("data-motion")).toBe("paused");
    // Pressing the page's switch again applies to the carousel again.
    act(() => setMotionPaused(false));
    act(() => setMotionPaused(true));
    expect(run.getAttribute("aria-pressed")).toBe("true");
    act(() => setMotionPaused(false));
  });

  it("keeps keyboard focus in the carousel when the control that had it leaves with its card", () => {
    env();
    const { container } = render(<SampleCarousel t={t} locale="en" />);
    const side = container.querySelector<HTMLButtonElement>(".nxc-card[data-offset='1'] button")!;
    side.focus();
    expect(document.activeElement).toBe(side);
    act(() => void fireEvent.click(side));
    // That card is the centre now (no button any more): focus went to "next", not to the page.
    expect(side.isConnected).toBe(false);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(c.carousel.next);
  });

  it("a picture holds the centre for its turn, then the next card comes in", () => {
    env();
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    const { container } = render(<SampleCarousel t={t} locale="en" />);
    const order = carouselJobs();
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
    expect(play!.getAttribute("aria-pressed")).toBe("false");
    act(() => void fireEvent.click(play!));
    // Pressed from the visitor's choice (not from whether frames arrived yet), with the same name; out of sight but for the keyboard.
    expect(play!.getAttribute("aria-pressed")).toBe("true");
    expect(play!.getAttribute("aria-label")).toBe(c.carousel.playClip);
    expect(play!.classList.contains("nxc-kbd")).toBe(true);
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
    expect(sliders.length).toBe(beforeAfterPairs(shownPairs).length);
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
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe(c.compare.pauseClip);
    // Paused, the clip is out of the page; a second tap brings it back.
    expect(frame.querySelector("video")).toBeNull();
    act(() => void fireEvent.pointerDown(frame, { pointerId: 3, clientX: 20 }));
    act(() => void fireEvent.pointerUp(frame, { pointerId: 3, clientX: 20 }));
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(frame.querySelector("video")).toBeTruthy();
  });

  it("names both models, the picture's and the clip's, inside the clip's box", () => {
    const { container } = render(<SampleCompare t={t} locale="en" />);
    for (const { clip, picture } of beforeAfterPairs(shownPairs)) {
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
    expect(SLOT_JOBS).not.toContain(job);
    expect(["de53f364-eaf7-4cd1-8d44-7b56b21b03b6"]).not.toContain(job);
  });

  it("a cut sentence keeps its ellipsis on screen: the typed words are clamped to three lines", () => {
    const css = readFileSync(join(ROOT, "components/site/prompt-ticker.css"), "utf8");
    expect(css).toMatch(/\.nxt-typed \{[^}]*-webkit-line-clamp: 3/);
  });
});

describe("no clip twice, and every file ours", () => {
  it("with the gallery's own exclude list, no sample is in two of these pieces, and none the slots or the list hold", () => {
    env();
    const { container } = render(
      <>
        <SampleTicker t={t} locale="en" exclude={SLOT_JOBS} />
        <SampleCarousel t={t} locale="en" exclude={SLOT_JOBS} />
        <SampleCompare t={t} locale="en" exclude={SLOT_JOBS} />
      </>,
    );
    const carousel = [...container.querySelectorAll(".nxc-card")].map((n) => n.getAttribute("data-showcase-entry")!);
    const compare = [...container.querySelectorAll(".nxb")].flatMap((n) => [n.getAttribute("data-showcase-entry")!, n.querySelector("[data-source-entry]")!.getAttribute("data-source-entry")!]);
    const ticker = sampleSectionJobs(SLOT_JOBS).filter((j) => !compare.includes(j));
    const all = [...carousel, ...compare, ...ticker];
    expect(new Set(all).size).toBe(all.length);
    for (const j of all) expect(SLOT_JOBS).not.toContain(j);
    // A job the owner keeps off the landing is in none of them.
    const off = carousel[0];
    const { container: again } = render(<SampleCarousel t={t} locale="en" exclude={[...SLOT_JOBS, off]} />);
    expect(again.querySelector(`[data-showcase-entry="${off}"]`)).toBeNull();
  });

  it("by default they leave out what the landing's gallery leaves out: the tool wall's pair and the sea and sky samples", () => {
    const { container } = render(
      <>
        <SampleTicker t={t} locale="en" />
        <SampleCarousel t={t} locale="en" />
        <SampleCompare t={t} locale="en" />
      </>,
    );
    for (const job of [...LANDING_LEFT_OUT, ...TOOL_JOBS]) {
      expect(container.querySelector(`[data-showcase-entry="${job}"]`), job).toBeNull();
      expect(container.querySelector(`[data-source-entry="${job}"]`), job).toBeNull();
    }
  });

  it("while the Shorts feed holds the page's loops, no player here has a turn and the carousel does not move", () => {
    env();
    const { container } = render(<SampleCarousel t={t} locale="en" />);
    expect(container.querySelector(".nxc")!.getAttribute("data-run")).toBe("true");
    let release = () => {};
    act(() => {
      release = holdClips();
    });
    expect(container.querySelector(".nxc")!.getAttribute("data-run")).toBe("false");
    act(() => release());
    expect(container.querySelector(".nxc")!.getAttribute("data-run")).toBe("true");
  });

  it("every picture is same-origin and lazy, and every clip sits inside its own sample's box", () => {
    env();
    const { container } = render(
      <>
        <SampleTicker t={t} locale="en" />
        <SampleCarousel t={t} locale="en" />
        <SampleCompare t={t} locale="en" />
      </>,
    );
    const imgs = [...container.querySelectorAll("[data-sample-section] img")];
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      expect(img.getAttribute("src") ?? "").not.toMatch(/^(https?:)?\/\//);
      for (const part of (img.getAttribute("srcset") ?? "").split(",")) expect(part.trim()).not.toMatch(/^(https?:)?\/\//);
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.closest("[data-showcase-entry]")).toBeTruthy();
    }
    const videos = [...container.querySelectorAll("[data-sample-section] video")];
    expect(videos.length).toBeGreaterThan(0);
    for (const v of videos) {
      const box = v.closest("[data-showcase-entry]");
      expect(box).toBeTruthy();
      for (const src of v.querySelectorAll("source")) expect(src.getAttribute("src") ?? "").not.toMatch(/^(https?:)?\/\//);
      expect(v.hasAttribute("muted") || (v as HTMLVideoElement).muted).toBe(true);
    }
  });
});
