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
import { Showcases } from "@/components/landing/Showcases";
import { CLIPS, SLOTS, slotMedia, type PlaceDef } from "@/components/site/samples";
import { TOOL_SAMPLES, studioToolsOpen, toolSource } from "@/lib/site/tool-samples";
import { SHOWCASE_ENTRIES } from "@/lib/site/showcase";
import { setMotionPaused } from "@/lib/site/motion";
import { buildCsp } from "@/lib/security/csp";
import { GALLERY, SAMPLE_CARD, outsideGallery, landingSamples, placeLabelProblems, without } from "./helpers/showcase-scope";
import { aiMarkOf } from "./helpers/ai-mark";

const ROOT = join(__dirname, "..");
const SRC = CLIPS.caravan;
const css = readFileSync(join(ROOT, "components/site/site-next.css"), "utf8");
const homeCss = readFileSync(join(ROOT, "components/landing/home/home.css"), "utf8");

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

  it("are the stock fallback of five slots, each of which keeps its still as the poster (frame 0 of the clip is that still)", () => {
    // Round 10: these are what a slot shows only until one of our samples fills it (its `ai` line); the fallback stays declared.
    const fallback = (slot: keyof typeof SLOTS): string | null => {
      const s: PlaceDef = SLOTS[slot];
      return s.clip ?? null;
    };
    // (The Approvals showcase has no slot any more: it is a drawn approval screen, components/landing/ApprovalCard.tsx. Nor do the
    // /pricing chat card and the publish desk's frame: both sit beside the example topic and play its own clip, components/site/slots.ts EXAMPLE_THUMB_JOB.)
    const moving = ["hero", "show.studio", "solutions.creative-studio", "auth.signup", "mcp.hero"] as const;
    for (const gone of ["show.approvals", "pricing.card", "solutions.youtube-channels"]) expect(Object.keys(SLOTS)).not.toContain(gone);
    for (const slot of moving) expect(SLOTS[slot].id, slot).toBe(fallback(slot));
    // The closing panel, the developers' photograph and the sign-in stage are still.
    for (const slot of ["landing.final", "solutions.developers", "auth.login"] as const) expect(fallback(slot), slot).toBeNull();
    for (const slot of Object.keys(SLOTS) as (keyof typeof SLOTS)[]) {
      const c = fallback(slot);
      if (c) expect(Object.keys(CLIPS)).toContain(c);
    }
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
  it.each(LOCALES.map((l) => l.code))("%s: the first screen and the closing panel each carry the labels of what they show (stock, or one of our samples with its badge only), and no stock clip claims to be Nightshift's output", (code) => {
    const t = dictionaries[code];
    env();
    const { container } = render(<Landing t={t} locale={code} pricing={{ kind: "announced" }} anchor={{ pack: { kind: "none" }, api: null, site: null }} showcase={[]} />);
    // Round 10: each slot shows one of our samples once its job is merged and named on its `ai` line, the stock picture until then.
    // Either way the labels are the ones for what is there (tests/helpers/showcase-scope.ts placeLabelProblems).
    // The first screen is our own clip (components/landing/home/HomeHero.tsx, no stock fallback): labelled AI-generated, never stock.
    const hero = container.querySelector("section.hm-hero")!;
    const heroClip = hero.querySelector(".hm-hero-media");
    if (heroClip) {
      expect(aiMarkOf(hero.querySelector(".hm-hero-credit .hm-badge"))).toEqual({ seen: t.site.gallery.badge, said: t.landingHome.hero.aiCredit });
      for (const w of [t.site.samples.tag, t.site.samples.frameTag, t.site.samples.clipTag]) expect(hero.textContent).not.toContain(w);
    }
    const fin = slotMedia("landing.final");
    const finCredit = container.querySelector(".nx-final-credit")!;
    if (fin.kind === "ai") {
      expect(finCredit.closest(SAMPLE_CARD)?.getAttribute("data-showcase-entry")).toBe(fin.entry.jobId);
      expect(placeLabelProblems(finCredit, fin, t.site)).toEqual([]);
    }
    else expect(finCredit.textContent).toMatch(/ \/ Pexels$/);
    // A box that plays something says what it plays: a stock clip by its name, a sample's as "sample".
    // (The model tiles, the tool wall, the third step and the Approvals card play samples' loops too, each inside its sample's box: checked on their own.)
    const clipBoxes = outsideGallery(container.querySelectorAll("[data-clip]")).filter((b) => !b.closest("#models, #tools, .nx-step-live, .nx-approve-art"));
    const expected = [
      ...(heroClip ? ["sample"] : []),
      ...(["landing.final"] as const).flatMap((s) => {
        const m = slotMedia(s);
        return m.kind === "ai" ? (m.moving ? ["sample"] : []) : m.clip ? [m.clip] : [];
      }),
    ];
    expect(clipBoxes.map((b) => b.getAttribute("data-clip"))).toEqual(expected);
    for (const b of clipBoxes) expect(b.querySelector("img")?.hasAttribute("alt")).toBe(true);
    expect(outsideGallery(container.querySelectorAll("video")).filter((v) => !v.closest("#models, #tools, .nx-step-live, .nx-approve-art"))).toHaveLength(expected.length);
    // Inside the gallery, a clip box is a sample's, never a stock one's: in its card, labelled AI-generated, with no stock label.
    const { clips } = landingSamples();
    const sampleBoxes = [...container.querySelectorAll(`${GALLERY} [data-clip]`)];
    expect(sampleBoxes).toHaveLength(clips);
    for (const b of sampleBoxes) {
      expect(b.getAttribute("data-clip")).toBe("sample");
      expect(b.closest(SAMPLE_CARD)).toBeTruthy();
      // The AI mark sits on the card over its media (components/site/media-card.css), never a stock label.
      // "AI" on screen in every language (owner decision 22 Nov); the card says "AI-generated" in full for a screen reader.
      expect(aiMarkOf(b.closest("[data-mf-card]")?.querySelector(".mf-ai"))).toEqual({ seen: t.site.gallery.badge, said: t.site.gallery.badgeName });
      expect(b.closest("[data-mf-card]")?.querySelector(".nx-result-badge[data-kind]")).toBeNull();
    }
    const sampleVideos = [...container.querySelectorAll(`${GALLERY} video`)];
    expect(sampleVideos).toHaveLength(clips);
    for (const v of sampleVideos) expect(v.closest("[data-clip='sample']")).toBeTruthy();
    expect(t.site.samples.clipTag).toMatch(code === "en" ? /^Example clip \(stock footage\)$/ : code === "ru" ? /^Пример клипа/ : /^Namuna klip/);
    const text = without(container, GALLERY).textContent ?? "";
    expect(text).not.toMatch(/made with Nightshift|Nightshift made|Nightshift-generated/i);
  });

  // The two showcases left the landing on 2026-11-22 (components/landing/Showcases.tsx, kept for a page that draws them).
  it("puts the keyboard's pause switch on the moving Studio picture and none on the drawn approval screen, the same switch, named \"Pause motion\" and visually hidden until focused", () => {
    const t = dictionaries.en;
    env();
    const { container } = render(<Showcases t={t} />);
    expect(container.querySelector("#video .nx-clip-pause")).toBeNull();
    expect(container.querySelector("#approvals .nx-clip-pause")).toBeNull();
    const m = slotMedia("show.studio");
    if (!(m.kind === "ai" ? m.moving : m.clip)) return expect(container.querySelector("#studio .nx-clip-pause")).toBeNull();
    const btn = container.querySelector("#studio .nx-show-pic .nx-clip-pause") as HTMLElement;
    // Its name is its own words, no icon (the owner wants no visible pause word or icon: the stylesheet hides it until focused).
    expect(btn.textContent).toBe(t.site.fx.pause);
    expect(btn.querySelector("svg")).toBeNull();
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(document.documentElement.getAttribute("data-motion")).toBe("paused");
    for (const b of container.querySelectorAll(".nx-clip-pause, .nx-motion-btn")) expect(b.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn);
    expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
    expect(css).toMatch(/\.nx-clip-pause \{[^}]*min-width: 44px; min-height: 44px;/);
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

describe("the capability wall (round 8, stock photographs replaced by AI-generated pictures): eight tiles, one per tool", () => {
  it("replaces the pill carousel in the \"how it works\" block: eight tiles, each with the tool's own name and description and whether it costs credits, under a label that says they are AI-generated pictures", () => {
    const t = dictionaries.en;
    env();
    const { container } = render(<Landing t={t} locale="en" pricing={{ kind: "announced" }} anchor={{ pack: { kind: "none" }, api: null, site: null }} showcase={[]} />);
    const how = container.querySelector("section#how")!;
    const wall = how.querySelector("#tools")!;
    expect(wall.querySelector("h3")?.textContent).toBe(t.site.toolStrip.title);
    expect(wall.querySelector(".nx-wall-label")?.textContent).toBe(t.site.wall.label);
    expect(wall.querySelector(".nx-wall-note")?.textContent).toBe(t.site.wall.note);
    const tiles = [...wall.querySelectorAll<HTMLElement>(".nx-wall-tile")];
    const named = t.site.studio.tools.filter((x) => x.id !== "editor");
    // Round 10: every tool once, each with its own name and words; the tools with a real output first.
    expect(tiles.map((x) => x.dataset.tool).sort()).toEqual(named.map((x) => x.id).sort());
    const withOutput = tiles.map((x) => x.hasAttribute("data-showcase-entry"));
    expect(withOutput).toEqual([...withOutput].sort((a, b) => Number(b) - Number(a)));
    for (const tile of tiles) {
      const id = tile.dataset.tool!;
      const tool = named.find((x) => x.id === id)!;
      const def = TOOL_SAMPLES[id];
      expect(tile.querySelector(".nx-wall-name")?.textContent).toBe(tool.title);
      expect(tile.querySelector(".nx-wall-body")?.textContent).toBe(tool.body);
      // Only the tool that costs no credits says so on its tile, and only while it can be used: "No credits" beside "Not available
      // yet" would read as on offer. The note says the rest once.
      expect(tile.querySelector(".nx-wall-price")?.textContent ?? null).toBe(id === "styles" && def.inStudio ? t.site.studio.free : null);
      // A tool no customer can use today says so in the Studio's own words (#735, lib/i18n/availability), and shows no output
      // (never a drawn result).
      // Our team's sample stays on a closed tool's tile, labelled AI-generated, beside the words.
      if (!def.inStudio) expect(tile.querySelector(".nx-wall-notyet")?.textContent).toBe(t.availability.notYet);
      else expect(tile.querySelector(".nx-wall-notyet")).toBeNull();
      // A real output is that sample's own box: its job, its model's name, AI-generated; lazy; Animate shows the still too.
      if (tile.hasAttribute("data-showcase-entry")) {
        expect(tile.dataset.showcaseEntry).toBe(def.job);
        expect(tile.querySelector(".nx-wall-credit")?.textContent).toContain(t.site.gallery.badgeName);
        // One status line and one small credit line, and no model name anywhere on the tile, words or alt text: the owner has not
        // decided whether the public site names models, and "this model is not in the Studio" only repeated "Not available yet"
        // (owner, 2026-11-14).
        // Seen: just "AI" (owner, 2026-11-22). Said: what it is and who made it.
        expect(aiMarkOf(tile.querySelector(".nx-wall-credit"))).toEqual({ seen: t.site.gallery.badge, said: `${t.site.gallery.badgeName} · ${t.site.wall.byTeam}` });
        const entry = SHOWCASE_ENTRIES.find((x) => x.jobId === def.job)!;
        const names = [entry.modelName, ...(toolSource(def.job) ? [SHOWCASE_ENTRIES.find((x) => x.jobId === toolSource(def.job))!.modelName] : [])];
        const said = tile.textContent + [...tile.querySelectorAll("img")].map((i) => i.getAttribute("alt")).join(" ");
        for (const name of names) expect(said).not.toContain(name);
        expect(said).not.toContain(t.site.gallery.notInStudio);
        expect(tile.querySelectorAll(".nx-ai-badge, .nx-ai-model, .nx-wall-model-note")).toHaveLength(0);
        if (toolSource(def.job)) expect(tile.querySelector(".nx-wall-from")?.textContent).toBe(t.site.wall.from);
        for (const img of tile.querySelectorAll("img")) expect(img.getAttribute("loading")).toBe("lazy");
        // Animate's still is the clip's own recorded input, never a typed id: before and after cannot disagree.
        const src = toolSource(def.job);
        expect(tile.querySelectorAll(".nx-wall-frame img")).toHaveLength(src ? 2 : 1);
        // The model tiles link to every sample on the page: the tile's sample and the still beside it carry their anchors.
        expect(tile.id).toBe(`sample-${def.job}`);
        if (src) expect(tile.querySelector(`#sample-${src}`)).toBeTruthy();
      }
      // Nothing on a tile is pressable: no maker's credit is linked on the public site (it is shown in the Studio).
      expect(tile.querySelectorAll("a")).toHaveLength(0);
      expect(tile.querySelector('button, [tabindex]:not([tabindex="-1"])')).toBeNull();
    }
    // The ninth tool, the Editor, is a plain line: it has no picture.
    expect(wall.querySelector(".nx-wall-editor")?.textContent).toContain(t.site.studio.tools.find((x) => x.id === "editor")!.title);
    expect(container.querySelector("section#tools")).toBeNull();
    // Two columns on a phone, four from 640 px.
    expect(css).toMatch(/\.nx-wall-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/@media \(min-width: 640px\) \{ \.nx-wall-grid \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  });
});

describe("one Start free at a time (round 5)", () => {
  it("tells the page while the sticky bar is up, and the bar is not drawn from 1024 px (the header is not sticky below it, so its button no longer steps aside)", () => {
    const { see } = env();
    document.body.innerHTML = '<div class="nx-hero"><div class="nx-actions"></div></div>';
    render(<StickyCta label="l" text="t" cta="c" dismiss="d" />);
    expect(document.documentElement.getAttribute("data-bar")).toBe("off");
    expect(css).toMatch(/@media \(min-width: 1024px\) \{ \.nx-bar \{ display: none; \} \}/);
    expect(css).not.toMatch(/html\[data-bar="on"\] \.st-header-tools/);
    void see;
    cleanup();
    expect(document.documentElement.hasAttribute("data-bar")).toBe(false);
  });
});

describe("the hero and the Try grid (round 5)", () => {
  it("sets the first screen as our clip with the words and the idea box over it, and keeps the chat card in How it works (round 10)", () => {
    const t = dictionaries.en;
    env();
    const { container } = render(<Landing t={t} locale="en" pricing={{ kind: "announced" }} anchor={{ pack: { kind: "none" }, api: null, site: null }} showcase={[]} />);
    // The first screen the owner kept (components/landing/home/HomeHero.tsx, 2026-11-22): the clip, the veil, the words, the label
    // and the page's pause switch.
    const hero = container.querySelector("section.hm-hero")!;
    expect([...hero.children].map((c) => c.className.split(" ")[0])).toEqual(["hm-hero-media", "hm-hero-veil", "hm-wrap", "hm-hero-credit", "nx-motion"]);
    // In the reference's order (kling.ai's first screen, the owner's "in this style", 2026-11-22): the title, one line, the bar.
    const order = [...hero.querySelector(".hm-hero-body")!.children].map((c) => c.className.split(" ")[0] || c.tagName);
    expect(order).toEqual(["ds-display", "hm-hero-sub", "hm-idea"]);
    // The headline is a display size above every section heading: on a desktop its largest is above the landing's section titles'
    // largest (.lp-root's --lp-h2, which the landing's .nx-h2 takes).
    const h2max = Number(css.match(/--lp-h2: clamp\(\d+px, [\d.]+vw, (\d+)px\)/)![1]);
    const h1max = Number(homeCss.match(/\.hm-hero-title \{[^}]*font-size: clamp\([^,]+, [^,]+, ([\d.]+)rem\)/)![1]) * 16;
    expect(h1max).toBeGreaterThan(h2max);
    // The chat card is the idea, not the picture: it sits under the steps, with no picture of its own.
    const card = container.querySelector("#how figure.nx-chat")!;
    expect(card.querySelector("img, video, .nx-result-art")).toBeNull();
    // The box takes 16 px or more (no zoom on a phone), and the promises wrap in a row under the facts.
    expect(homeCss).toMatch(/\.hm-idea-field \{[^}]*font-size: 1rem;/);
    expect(css).toMatch(/\.nx-facts-more \.nx-trust \{ display: flex; flex-wrap: wrap;/);
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

/**
 * The tool wall's lines (lib/site/tool-samples.ts) against what this repository can check. What would break: a tile showing a sample
 * of another tool (a still on the Animate tile, a picture on Video); Animate's "before" picture that is not what the clip was made
 * from; a tool marked available that no registry model could serve (CLAUDE.md #5: never claim what is not backed).
 */
describe("the tool wall's lines", () => {
  const REGISTRY = JSON.parse(readFileSync(join(__dirname, "..", "..", "schemas", "model_registry.json"), "utf8")) as {
    models: { id: string; capabilities: string[]; terms_gate?: string | null; shutdown?: { on: string } | null }[];
  };
  const today = new Date().toISOString().slice(0, 10);

  it("each tile's sample is a job of its tool's capability, and Animate's still is that clip's recorded input", () => {
    for (const [tool, def] of Object.entries(TOOL_SAMPLES)) {
      if (!def.job) continue;
      const e = SHOWCASE_ENTRIES.find((x) => x.jobId === def.job);
      expect(e, tool).toBeTruthy();
      expect(e!.capability, tool).toBe(def.capability);
      const src = toolSource(def.job);
      expect(src).toBe(e!.kind === "video" && e!.input.kind === "operator_job" ? e!.input.jobId : null);
    }
    expect(toolSource(TOOL_SAMPLES.animate.job)).toBeTruthy();
  });

  // The live database on 2026-11-13 (a read-only check): all 82 model_registry rows availability='hidden', so no customer can make
  // anything in the Studio. Flip a line, and this list, only when the owner opens a model of it (PR #736 / migration 0160).
  it("says every model-backed tool is closed today, as the live database is (all models hidden, 2026-11-13), and the landing's copy follows", () => {
    const open = Object.entries(TOOL_SAMPLES).filter(([, d]) => d.inStudio).map(([id]) => id);
    // Styles is the free style library, not a model: hidden models do not close it (owner, 2026-11-14; evidence in tool-samples.ts).
    expect(open).toEqual(["styles"]);
    expect(TOOL_SAMPLES.styles.capability).toBeNull();
    expect(studioToolsOpen()).toBe(false);
  });

  it("a tool marked available (none today) has at least one registry model of its capability that is not terms-gated and not past its shutdown", () => {
    for (const [tool, def] of Object.entries(TOOL_SAMPLES)) {
      if (!def.inStudio || def.capability === null) continue;
      const servable = REGISTRY.models.filter((m) => m.capabilities.includes(def.capability!) && !m.terms_gate && !(m.shutdown && m.shutdown.on <= today));
      expect(servable.length, tool).toBeGreaterThan(0);
    }
  });

  it("a tool with no line claims nothing: the wall does not draw it, and no default says it can be used", () => {
    const src = readFileSync(join(__dirname, "..", "components/landing/CapabilityWall.tsx"), "utf8");
    expect(src).not.toMatch(/\?\? \{ job: null, inStudio: true \}/);
    expect(src).toMatch(/if \(!\(tool\.id in TOOL_ICON\) \|\| !def\) return \[\];/);
  });
});
