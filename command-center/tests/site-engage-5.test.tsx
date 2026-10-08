// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries, LOCALES } from "@/lib/i18n";
import { LoopClip } from "@/components/site/LoopClip";
import { StickyCta } from "@/components/site/StickyCta";
import { Landing } from "@/components/landing/Landing";
import { CLIPS, SLOTS, slotClip } from "@/components/site/samples";
import { setMotionPaused } from "@/lib/site/motion";
import { buildCsp } from "@/lib/security/csp";

const ROOT = join(__dirname, "..");
const SRC = CLIPS.caravan;
const css = readFileSync(join(ROOT, "components/site/site-next.css"), "utf8");

/** What the page environment looks like to a clip: reduced motion, Save-Data, a visible element. */
function env({ reduce = false, saveData = false, effectiveType = "4g", wide = false }: { reduce?: boolean; saveData?: boolean; effectiveType?: string; wide?: boolean } = {}) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") ? reduce : q.includes("min-width: 860px") ? wide : false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
  Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData, effectiveType } });
  const observers: Array<{ cb: IntersectionObserverCallback; el?: Element }> = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      cb: IntersectionObserverCallback;
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
        observers.push({ cb });
      }
      observe(el: Element) {
        observers[observers.length - 1].el = el;
      }
      unobserve() {}
      disconnect() {}
    },
  );
  const see = (visible: boolean) =>
    act(() => {
      for (const o of observers) o.cb([{ isIntersecting: visible, target: o.el as Element } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
  return { see };
}

let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;
beforeEach(() => {
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  HTMLMediaElement.prototype.play = play as never;
  HTMLMediaElement.prototype.pause = pause as never;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setMotionPaused(false);
  Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
});

describe("the clips (round 5)", () => {
  it("are six, each in two renditions (1280 x 720 for a screen, 640 x 360 for a phone) and two formats: the screen's between 100 and 450 KB, the phone's between 30 and 150 KB", () => {
    expect(Object.keys(CLIPS).sort()).toEqual(["caravan", "cloud", "coast", "floating", "loom", "pottery"]);
    for (const name of Object.keys(CLIPS)) for (const ext of ["mp4", "webm"]) {
      const big = statSync(join(ROOT, "components/site/clips", `${name}.${ext}`)).size;
      const small = statSync(join(ROOT, "components/site/clips", `${name}-sm.${ext}`)).size;
      expect(big, `${name}.${ext}`).toBeLessThanOrEqual(450 * 1024);
      expect(big, `${name}.${ext}`).toBeGreaterThan(100 * 1024);
      expect(small, `${name}-sm.${ext}`).toBeLessThanOrEqual(150 * 1024);
      expect(small, `${name}-sm.${ext}`).toBeGreaterThan(30 * 1024);
    }
  });

  it("are one pixel smaller than the still under them, so the still stays the page's LCP element", () => {
    expect(css).toMatch(/\.nx-clip \{ position: absolute; inset: 1px; width: calc\(100% - 2px\); height: calc\(100% - 2px\);/);
  });

  it("belong to six slots, each of which keeps its still as the poster (frame 0 of the clip is that still)", () => {
    expect(slotClip("hero")).toBe("cloud");
    expect(slotClip("show.studio")).toBe("pottery");
    expect(slotClip("show.approvals")).toBe("coast");
    expect(slotClip("pricing.card")).toBe("floating");
    expect(slotClip("solutions.youtube-channels")).toBe("caravan");
    expect(slotClip("solutions.creative-studio")).toBe("loom");
    for (const slot of ["hero", "show.studio", "show.approvals", "pricing.card", "solutions.youtube-channels", "solutions.creative-studio"] as const) expect(SLOTS[slot].id).toBe(slotClip(slot));
    // The library, the closing panel, the developers' photograph and the sign-in stages are still: nothing moves on them (the sign-in pages have no pause switch).
    for (const slot of ["show.video", "landing.final", "solutions.developers", "auth.login", "auth.signup"] as const) expect(slotClip(slot), slot).toBeNull();
  });

  it("are served from /_next/static/media (a path the middleware never gates) through one webpack rule, and the CSP already allows same-origin media (nothing in the CSP changed)", () => {
    const cfg = readFileSync(join(ROOT, "next.config.ts"), "utf8");
    expect(cfg).toMatch(/test: \/\\\.\(mp4\|webm\)\$\/i, type: "asset\/resource", generator: \{ filename: "static\/media\/\[name\]\.\[hash\]\[ext\]" \}/);
    // The rule is webpack-only: a Turbopack script would ignore it and the clips would not build.
    const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
    for (const cmd of Object.values(scripts)) expect(cmd).not.toMatch(/--turbo/);
    const mw = readFileSync(join(ROOT, "middleware.ts"), "utf8");
    expect(mw).toContain("_next/static/");
    const policy = buildCsp({ nonce: "n", supabaseUrl: "https://x.supabase.co", dev: false } as never);
    expect(policy).toMatch(/media-src 'self' /);
    expect(policy).toMatch(/default-src 'self'/);
  });
});

describe("LoopClip", () => {
  it("renders a muted, looping, inline video with both sources, no controls and no download until it is wanted, hidden from assistive technology", () => {
    env();
    const { container } = render(
      <div data-clip="caravan">
        <LoopClip clip="caravan" poster="/p.webp" />
      </div>,
    );
    const v = container.querySelector("video")!;
    expect(v.muted).toBe(true);
    expect(v.loop).toBe(true);
    expect(v.getAttribute("playsinline")).not.toBeNull();
    expect(v.getAttribute("preload")).toBe("none");
    expect(v.hasAttribute("controls")).toBe(false);
    expect(v.getAttribute("aria-hidden")).toBe("true");
    expect(v.getAttribute("tabindex")).toBe("-1");
    // WebM first, MP4 after it (a browser takes the first it can play); the still is the poster. On a phone, the 640 x 360 rendition.
    expect([...v.querySelectorAll("source")].map((s) => [s.getAttribute("type"), s.getAttribute("src")])).toEqual([
      ["video/webm", SRC.smWebm],
      ["video/mp4", SRC.smMp4],
    ]);
    expect(v.getAttribute("poster")).toBe("/p.webp");
  });

  it("gives a screen of 860 px or more the 1280 x 720 rendition and a phone the 640 x 360 one (a media attribute on a video's source is not honoured, so the choice is made when it mounts)", () => {
    env({ wide: true });
    const { container } = render(
      <div>
        <LoopClip clip="caravan" poster="/p.webp" />
      </div>,
    );
    expect([...container.querySelectorAll("source")].map((s) => s.getAttribute("src"))).toEqual([SRC.webm, SRC.mp4]);
  });

  it.each([
    ["reduced motion", { reduce: true }],
    ["Save-Data", { saveData: true }],
    ["a slow connection", { effectiveType: "3g" }],
  ])("is not rendered at all under %s: the still is all there is, and nothing is fetched", (_name, opts) => {
    env(opts);
    const { container } = render(
      <div>
        <LoopClip clip="caravan" poster="/p.webp" />
      </div>,
    );
    expect(container.querySelector("video")).toBeNull();
    expect(play).not.toHaveBeenCalled();
  });

  it("plays a later clip only once it is near the screen, pauses it when it leaves, and says it is live (the badge swaps) when it plays", () => {
    const { see } = env();
    const { container } = render(
      <div data-clip="library">
        <LoopClip clip="caravan" poster="/p.webp" />
      </div>,
    );
    const v = container.querySelector("video")!;
    expect(play).not.toHaveBeenCalled();
    see(true);
    expect(play).toHaveBeenCalledTimes(1);
    expect(container.firstElementChild!.hasAttribute("data-live")).toBe(false);
    fireEvent(v, new Event("playing"));
    expect(container.firstElementChild!.getAttribute("data-live")).toBe("true");
    see(false);
    expect(pause).toHaveBeenCalled();
  });

  it("starts the first screen's clip only after the page has loaded and gone idle, never before", () => {
    vi.useFakeTimers();
    const { see } = env();
    Object.defineProperty(document, "readyState", { configurable: true, get: () => "loading" });
    const { container } = render(
      <div>
        <LoopClip clip="caravan" poster="/p.webp" early />
      </div>,
    );
    see(true);
    expect(play).not.toHaveBeenCalled();
    Object.defineProperty(document, "readyState", { configurable: true, get: () => "complete" });
    act(() => void window.dispatchEvent(new Event("load")));
    act(() => void vi.advanceTimersByTime(1500));
    expect(play).toHaveBeenCalledTimes(1);
    expect(container.querySelector("video")).not.toBeNull();
    Reflect.deleteProperty(document, "readyState");
  });

  it("stops when the visitor presses the page's pause switch, and carries on when they release it", () => {
    const { see } = env();
    render(
      <div>
        <LoopClip clip="caravan" poster="/p.webp" />
      </div>,
    );
    see(true);
    expect(play).toHaveBeenCalledTimes(1);
    act(() => setMotionPaused(true));
    expect(pause).toHaveBeenCalled();
    play.mockClear();
    act(() => setMotionPaused(false));
    expect(play).toHaveBeenCalledTimes(1);
  });
});

describe("the landing's clips are labelled for what they are (round 5)", () => {
  it.each(LOCALES.map((l) => l.code))("%s: the hero card and two showcases carry both labels (frame and clip), the clip sentence under them, and no clip claims to be Nightshift's output", (code) => {
    const t = dictionaries[code];
    env();
    const { container } = render(<Landing t={t} locale={code} pricing={{ kind: "announced" }} anchor={{ pack: { kind: "none" }, api: null, site: null }} showcase={[]} />);
    const clipBoxes = [...container.querySelectorAll("[data-clip]")];
    expect(clipBoxes.map((b) => b.getAttribute("data-clip"))).toEqual(["cloud", "pottery", "coast"]);
    for (const b of clipBoxes) {
      // The still under a clip is a frame of stock footage.
      expect(b.querySelector(".nx-result-badge[data-kind='still']")?.textContent).toBe(t.site.samples.frameTag);
      expect(b.querySelector(".nx-result-badge[data-kind='clip']")?.textContent).toBe(t.site.samples.clipTag);
      expect(b.querySelector("img")?.getAttribute("alt")).toBeTruthy();
    }
    expect(container.querySelectorAll("video")).toHaveLength(3);
    expect(t.site.samples.clipTag).toMatch(code === "en" ? /^Example clip \(stock footage\)$/ : code === "ru" ? /^Пример клипа/ : /^Namuna klip/);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/made with Nightshift|Nightshift made|Nightshift-generated/i);
  });

  it("puts a pause button on each of the two moving pictures in the showcases (the hero has the page's switch) and none on the still one, the same switch, named \"Pause motion\"", () => {
    const t = dictionaries.en;
    env();
    const { container } = render(<Landing t={t} locale="en" pricing={{ kind: "announced" }} anchor={{ pack: { kind: "none" }, api: null, site: null }} showcase={[]} />);
    expect(container.querySelector("#video .nx-clip-pause")).toBeNull();
    for (const id of ["studio", "approvals"]) {
      const btn = container.querySelector(`#${id} .nx-show-pic .nx-clip-pause`) as HTMLElement;
      expect(btn.getAttribute("aria-label")).toBe(t.site.fx.pause);
      expect(btn.getAttribute("aria-pressed")).toBe("false");
    }
    const first = container.querySelector("#studio .nx-clip-pause") as HTMLElement;
    fireEvent.click(first);
    expect(document.documentElement.getAttribute("data-motion")).toBe("paused");
    for (const b of container.querySelectorAll(".nx-clip-pause, .nx-motion-btn")) expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(css).toMatch(/\.nx-clip-pause \{[^}]*width: 44px; height: 44px;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.nx-clip-pause \{ display: none; \} \}/);
  });

  it("keeps the badge above the showcase gradient: the gradient is the picture's ::after (z-index 1), the badge is 2 and the pause button 3, so the label is never painted over (it read 1.5:1 when the card's own ::after covered it), and its own dark pill gives white text at least 4.5:1 on any still", () => {
    const z = (re: RegExp) => Number(css.match(re)?.[1]);
    expect(css).not.toMatch(/\.nx-show-card::after/);
    const gradient = z(/\.nx-show-pic::after \{[^}]*z-index: (\d+)/);
    const badge = z(/\.nx-show-pic \.nx-result-badge \{ z-index: (\d+)/);
    const pause = z(/\.nx-clip-pause \{[^}]*z-index: (\d+)/);
    expect(gradient).toBe(1);
    expect(badge).toBeGreaterThan(gradient);
    expect(pause).toBeGreaterThan(badge);
    // The badge's own background: the darkest-case arithmetic for white text over the brightest pixel of any still.
    const alpha = Number(css.match(/\.nx-result-badge \{[^}]*background: rgba\(0, 0, 0, ([\d.]+)\)/s)?.[1]);
    const lum = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    expect(1.05 / (lum(255 * (1 - alpha)) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the badge rule in the stylesheet: the clip label only shows while it plays, the still label otherwise, and the clip is never drawn under reduced motion", () => {
    expect(css).toMatch(/\.nx-result-badge\[data-kind="clip"\] \{ display: none; \}/);
    expect(css).toMatch(/\[data-clip\]\[data-live="true"\] > \.nx-result-badge\[data-kind="still"\] \{ display: none; \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\n  \.nx-clip \{ display: none; \}/);
  });
});

describe("the capability wall (round 8): eight stock photographs, one per tool", () => {
  it("replaces the pill carousel in the \"how it works\" block: eight tiles, each with the tool's own name and description, whether it costs credits, and its photographer's credit, under a label that says they are stock photos", () => {
    const t = dictionaries.en;
    env();
    const { container } = render(<Landing t={t} locale="en" pricing={{ kind: "announced" }} anchor={{ pack: { kind: "none" }, api: null, site: null }} showcase={[]} />);
    const how = container.querySelector("section#how")!;
    const wall = how.querySelector("#tools")!;
    expect(wall.querySelector("h3")?.textContent).toBe(t.site.toolStrip.title);
    expect(wall.querySelector(".nx-wall-label")?.textContent).toBe(t.site.wall.label);
    expect(wall.querySelector(".nx-wall-note")?.textContent).toBe(t.site.wall.note);
    const tiles = [...wall.querySelectorAll(".nx-wall-tile")];
    const named = t.site.studio.tools.filter((x) => x.id !== "editor");
    expect(tiles.map((x) => x.querySelector(".nx-wall-name")?.textContent)).toEqual(named.map((x) => x.title));
    expect(tiles.map((x) => x.querySelector(".nx-wall-body")?.textContent)).toEqual(named.map((x) => x.body));
    for (const [i, tile] of tiles.entries()) {
      const id = named[i].id;
      // Only the tool that costs no credits says so on its tile; the note says the rest once.
      expect(tile.querySelector(".nx-wall-price")?.textContent ?? null).toBe(id === "styles" ? t.site.studio.free : null);
      expect(tile.querySelector(".nx-wall-credit")?.textContent).toMatch(/ \/ Pexels$/);
      expect(tile.querySelector("img")?.getAttribute("loading")).toBe("lazy");
      expect(tile.querySelector("a, button, [tabindex]")).toBeNull();
    }
    // The ninth tool, the Editor, is a plain line: it has no photograph.
    expect(wall.querySelector(".nx-wall-editor")?.textContent).toContain(t.site.studio.tools.find((x) => x.id === "editor")!.title);
    expect(container.querySelector("section#tools")).toBeNull();
    // Two columns on a phone, four from 640 px.
    expect(css).toMatch(/\.nx-wall-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/@media \(min-width: 640px\) \{ \.nx-wall-grid \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/\.nx-wall-credit \{[^}]*font-size: 14px/);
  });
});

describe("one Start free at a time (round 5)", () => {
  it("tells the page while the sticky bar is up, so the header's button steps aside on a phone, and the bar is not drawn from 1024 px", () => {
    const { see } = env();
    document.body.innerHTML = '<div class="nx-hero"><div class="nx-actions"></div></div>';
    render(<StickyCta label="l" text="t" cta="c" dismiss="d" />);
    expect(document.documentElement.getAttribute("data-bar")).toBe("off");
    expect(css).toMatch(/@media \(min-width: 1024px\) \{ \.nx-bar \{ display: none; \} \}/);
    expect(css).toMatch(/@media \(max-width: 1023px\) \{ html\[data-bar="on"\] \.st-header-tools > \.st-key \{ visibility: hidden; \} \}/);
    void see;
    cleanup();
    expect(document.documentElement.hasAttribute("data-bar")).toBe(false);
  });
});

describe("the hero and the Try grid (round 5)", () => {
  it("puts the chat card beside the headline on a desktop and the button, then the card, then the words on a phone", () => {
    const t = dictionaries.en;
    env();
    const { container } = render(<Landing t={t} locale="en" pricing={{ kind: "announced" }} anchor={{ pack: { kind: "none" }, api: null, site: null }} showcase={[]} />);
    const grid = container.querySelector(".nx-hero-grid")!;
    expect([...grid.children].map((c) => c.className)).toEqual(["nx-hero-copy", "nx-hero-visual"]);
    expect(grid.querySelector(".nx-hero-copy h1")).toBeTruthy();
    expect(css).toMatch(/\.nx-hero-grid \{ display: grid; grid-template-columns: minmax\(0, 1\.2fr\) minmax\(0, 0\.8fr\)/);
    expect(css).toMatch(/\.nx-hero-copy \.nx-actions \{ order: 2;/);
    expect(css).toMatch(/\.nx-hero-visual \{ order: 3;/);
    expect(css).toMatch(/\.nx-hero-copy \.nx-lead \{ order: 4;/);
    expect(css).toMatch(/\.nx-chat \.nx-result-art \{ aspect-ratio: 16 \/ 10; \}/);
    // The promises are one per line on a desktop: a row that wraps differently in the fallback face moved the column (CLS 0.12).
    expect(css).toMatch(/\.nx-hero-copy \.nx-trust \{ flex-direction: column;/);
  });

  it("lays the plan cards out in full rows (three columns, the picture card down the right across two rows) and keeps a card's box while its words are held back", () => {
    expect(css).toMatch(/\.nx-try-cards \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
    expect(css).toMatch(/\.nx-try-card\[data-id="thumb"\] \{ grid-column: 3; grid-row: 1 \/ span 2; \}/);
    expect(css).toMatch(/\.nx-try-card\[data-on="false"\] > :not\(\.nx-try-card-h\)/);
    expect(css).not.toMatch(/\.nx-try-card\[data-on="false"\] \{ visibility: hidden/);
  });
});

describe("small type fixes (round 5)", () => {
  it("raises the header's language code and the /mcp banner to 14 px, and gives the carousel track a scroll padding", () => {
    const site = readFileSync(join(ROOT, "components/site/site.css"), "utf8");
    expect(site).toMatch(/\.st \[aria-haspopup="listbox"\] \.text-xs \{ font-size: 14px;/);
    expect(site).toMatch(/\.st-banner \{[^}]*font-size: 14px;/);
    expect(site).toMatch(/\.ml-car-track \{[^}]*scroll-padding-inline: 16px;/);
    expect(site).not.toMatch(/font-size: 13(\.5)?px/);
  });
});
