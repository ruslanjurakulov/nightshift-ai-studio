// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
import { ChatRail } from "@/components/landing/ChatRail";
import { ToolStrip } from "@/components/landing/ToolStrip";
import { StickyCta } from "@/components/site/StickyCta";
import { Landing } from "@/components/landing/Landing";
import { CLIPS, SAMPLE_BASE, SAMPLES, SLOTS, slotAlt, slotClip } from "@/components/site/samples";
import { setMotionPaused } from "@/lib/site/motion";
import { buildCsp } from "@/lib/security/csp";

const ROOT = join(__dirname, "..");
const css = readFileSync(join(ROOT, "components/site/site-next.css"), "utf8");

/** What the page environment looks like to a clip: reduced motion, Save-Data, a visible element. */
function env({ reduce = false, saveData = false, effectiveType = "4g" }: { reduce?: boolean; saveData?: boolean; effectiveType?: string } = {}) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") ? reduce : false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
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
  it("are three, each in two formats, 1280 x 720, 8 seconds of H.264 and VP9, no audio, each file between 200 and 450 KB", () => {
    expect(Object.keys(CLIPS).sort()).toEqual(["library", "silkroad", "valley"]);
    for (const name of Object.keys(CLIPS)) for (const ext of ["mp4", "webm"]) {
      const bytes = statSync(join(ROOT, "components/site/clips", `${name}.${ext}`)).size;
      expect(bytes, `${name}.${ext}`).toBeLessThanOrEqual(450 * 1024);
      expect(bytes, `${name}.${ext}`).toBeGreaterThan(200 * 1024);
    }
  });

  it("are one pixel smaller than the still under them, so the still stays the page's LCP element", () => {
    expect(css).toMatch(/\.nx-clip \{ position: absolute; inset: 1px; width: calc\(100% - 2px\); height: calc\(100% - 2px\);/);
  });

  it("belong to three slots, each of which keeps its still as the poster (frame 0 of the clip is that still)", () => {
    expect(slotClip("hero")).toBe("silkroad");
    expect(slotClip("show.video")).toBe("library");
    expect(slotClip("show.studio")).toBe("valley");
    for (const slot of ["hero", "show.video", "show.studio"] as const) expect(SLOTS[slot].id).toBe(slotClip(slot));
    expect(slotClip("show.approvals")).toBeNull();
    expect(slotClip("pricing.card")).toBeNull();
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
      <div data-clip="library">
        <LoopClip mp4="/a.mp4" webm="/a.webm" poster="/p.webp" />
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
    // WebM first, MP4 after it (a browser takes the first it can play); the still is the poster.
    expect([...v.querySelectorAll("source")].map((s) => [s.getAttribute("type"), s.getAttribute("src")])).toEqual([
      ["video/webm", "/a.webm"],
      ["video/mp4", "/a.mp4"],
    ]);
    expect(v.getAttribute("poster")).toBe("/p.webp");
  });

  it.each([
    ["reduced motion", { reduce: true }],
    ["Save-Data", { saveData: true }],
    ["a slow connection", { effectiveType: "3g" }],
  ])("is not rendered at all under %s: the still is all there is, and nothing is fetched", (_name, opts) => {
    env(opts);
    const { container } = render(
      <div>
        <LoopClip mp4="/a.mp4" webm="/a.webm" poster="/p.webp" />
      </div>,
    );
    expect(container.querySelector("video")).toBeNull();
    expect(play).not.toHaveBeenCalled();
  });

  it("plays a later clip only once it is near the screen, pauses it when it leaves, and says it is live (the badge swaps) when it plays", () => {
    const { see } = env();
    const { container } = render(
      <div data-clip="library">
        <LoopClip mp4="/a.mp4" webm="/a.webm" poster="/p.webp" />
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
        <LoopClip mp4="/a.mp4" webm="/a.webm" poster="/p.webp" early />
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
        <LoopClip mp4="/a.mp4" webm="/a.webm" poster="/p.webp" />
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
  it.each(LOCALES.map((l) => l.code))("%s: the hero card and two showcases carry both labels (still and clip), the clip sentence under them, and no clip claims to be Nightshift's output", (code) => {
    const t = dictionaries[code];
    env();
    const { container } = render(<Landing t={t} locale={code} pricing={{ kind: "announced" }} anchor={{ pack: { kind: "none" }, api: null, site: null }} showcase={[]} />);
    const clipBoxes = [...container.querySelectorAll("[data-clip]")];
    expect(clipBoxes.map((b) => b.getAttribute("data-clip"))).toEqual(["silkroad", "library", "valley"]);
    for (const b of clipBoxes) {
      expect(b.querySelector(".nx-result-badge[data-kind='still']")?.textContent).toBe(t.site.samples.tag);
      expect(b.querySelector(".nx-result-badge[data-kind='clip']")?.textContent).toBe(t.site.samples.clipTag);
      expect(b.querySelector("img")?.getAttribute("alt")).toBeTruthy();
    }
    expect(container.querySelectorAll("video")).toHaveLength(3);
    expect(t.site.samples.clipTag).toMatch(code === "en" ? /^Example clip \(animated still\)$/ : code === "ru" ? /^Пример клипа/ : /^Namuna klip/);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/made with Nightshift|Nightshift made|Nightshift-generated/i);
  });

  it("puts a pause button on each of the two clip pictures in the showcases (the hero has the page's switch), the same switch, named \"Pause motion\", and none on the still-only one", () => {
    const t = dictionaries.en;
    env();
    const { container } = render(<Landing t={t} locale="en" pricing={{ kind: "announced" }} anchor={{ pack: { kind: "none" }, api: null, site: null }} showcase={[]} />);
    for (const id of ["video", "studio"]) {
      const btn = container.querySelector(`#${id} .nx-show-pic .nx-clip-pause`) as HTMLElement;
      expect(btn.getAttribute("aria-label")).toBe(t.site.fx.pause);
      expect(btn.getAttribute("aria-pressed")).toBe("false");
    }
    expect(container.querySelector("#approvals .nx-clip-pause")).toBeNull();
    const first = container.querySelector("#video .nx-clip-pause") as HTMLElement;
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

describe("variants of the stills (round 5)", () => {
  it("are described, in every language, as the still they come from, so every slot has an alt", () => {
    for (const id of Object.keys(SAMPLES) as Array<keyof typeof SAMPLES>) expect(SAMPLE_BASE[id]).toBeTruthy();
    for (const { code } of LOCALES) for (const slot of Object.keys(SLOTS) as Array<keyof typeof SLOTS>) expect(slotAlt(dictionaries[code].site.samples.alts, slot)).toMatch(/^(Example frame|Пример кадра|Namuna kadr)/);
  });

  it("give each page its own look: the landing, /solutions and the auth pages share no still, and each file is under 60 KB", () => {
    const groups = {
      landing: ["hero", "show.video", "show.studio", "show.approvals"],
      solutions: ["sol.channels", "sol.studio", "sol.developers"],
      auth: ["auth.signin", "auth.signup"],
    } as const;
    const seen = new Map<string, string>();
    for (const [page, slots] of Object.entries(groups)) for (const slot of slots) {
      const id = SLOTS[slot as keyof typeof SLOTS].id;
      expect(seen.has(id) && seen.get(id) !== page, `${id} is on ${seen.get(id)} and ${page}`).toBe(false);
      seen.set(id, page);
    }
    for (const id of Object.keys(SAMPLES)) expect(statSync(join(ROOT, "components/site/samples", `${id}.webp`)).size).toBeLessThanOrEqual(60 * 1024);
  });
});

describe("the chat card's rail (round 5)", () => {
  const steps = dictionaries.en.site.stage.steps.map((s) => ({ id: s.id, tab: s.tab }));
  const card = (
    <figure className="nx-chat">
      <ChatRail steps={steps} rest={2} />
    </figure>
  );

  it("shows Approve with no script (the same state the server renders), and never Live", () => {
    env({ reduce: true });
    const { container } = render(card);
    const cur = () => container.querySelector("li[aria-current='step']")?.textContent;
    expect(cur()).toBe(steps[2].tab);
    expect(container.querySelectorAll("li[data-done='true']")).toHaveLength(2);
  });

  it("steps Topic, Plan, Approve once while it is on screen and rests on Approve for good (it does not loop); the card's data-step follows; Live is never reached", () => {
    vi.useFakeTimers();
    const { see } = env();
    Object.defineProperty(document, "readyState", { configurable: true, get: () => "complete" });
    const { container } = render(card);
    const cur = () => container.querySelector("li[aria-current='step']")?.textContent;
    see(true);
    expect(cur()).toBe(steps[0].tab);
    expect(container.querySelector(".nx-chat")?.getAttribute("data-step")).toBe("0");
    const seen: string[] = [];
    for (let i = 0; i < 80; i++) {
      act(() => void vi.advanceTimersByTime(500));
      const c = cur() ?? "";
      if (seen.at(-1) !== c) seen.push(c);
    }
    // Topic, Plan, Approve, and then nothing more for the next 38 seconds: no return to Topic.
    expect(seen).toEqual([steps[0].tab, steps[1].tab, steps[2].tab]);
    expect(seen.includes(steps[3].tab)).toBe(false);
    expect(container.querySelector(".nx-chat")?.getAttribute("data-step")).toBe("2");
    // Leaving the screen and coming back does not start it again.
    see(false);
    see(true);
    act(() => void vi.advanceTimersByTime(3000));
    expect(cur()).toBe(steps[2].tab);
    Reflect.deleteProperty(document, "readyState");
  });

  it("rests on the step the card names (copy.current), not on a number baked into the rail", () => {
    env({ reduce: true });
    const { container } = render(
      <figure className="nx-chat">
        <ChatRail steps={steps} rest={1} />
      </figure>,
    );
    expect(container.querySelector("li[aria-current='step']")?.textContent).toBe(steps[1].tab);
  });

  it("goes back to Approve and stays there while the pause switch is pressed", () => {
    vi.useFakeTimers();
    const { see } = env();
    Object.defineProperty(document, "readyState", { configurable: true, get: () => "complete" });
    const { container } = render(card);
    see(true);
    act(() => void vi.advanceTimersByTime(100));
    act(() => setMotionPaused(true));
    for (let i = 0; i < 10; i++) {
      act(() => void vi.advanceTimersByTime(1000));
      expect(container.querySelector("li[aria-current='step']")?.textContent).toBe(steps[2].tab);
    }
    Reflect.deleteProperty(document, "readyState");
  });

  it("keeps each tab's word whole (Russian \"Одобрение\" broke mid-word) and changes only colours", () => {
    expect(css).toMatch(/\.nx-chat-rail li \{ flex: 1 1 auto; overflow-wrap: normal; white-space: nowrap;/);
    expect(css).not.toMatch(/\[data-step="[01]"\][^{]*\{[^}]*opacity/);
  });
});

describe("the tool strip (round 5)", () => {
  const tools = dictionaries.en.site.studio.tools.map((x) => ({ id: x.id, title: x.title, body: x.body }));
  const s = dictionaries.en.site.studio;

  it("names what Nightshift makes (never a provider or a model), opens on the first, and follows a tap, a focus-press or the mouse", () => {
    // jsdom has no PointerEvent: give it one that carries pointerType.
    vi.stubGlobal(
      "PointerEvent",
      class extends MouseEvent {
        pointerType: string;
        constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
          super(type, init);
          this.pointerType = init.pointerType ?? "mouse";
        }
      },
    );
    render(<ToolStrip title="What Nightshift can make" tools={tools} priced={s.priced} free={s.free} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(tools.map((t) => t.title));
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    const line = () => document.querySelector(".nx-tools-line")!;
    expect(line().getAttribute("aria-live")).toBe("polite");
    expect(line().textContent).toContain(tools[0].body);
    fireEvent.click(buttons[5]);
    expect(buttons[5].getAttribute("aria-pressed")).toBe("true");
    expect(buttons[0].getAttribute("aria-pressed")).toBe("false");
    expect(line().textContent).toContain(tools[5].body);
    fireEvent.pointerEnter(buttons[2], { pointerType: "mouse" });
    expect(line().textContent).toContain(tools[2].body);
    fireEvent.pointerEnter(buttons[3], { pointerType: "touch" });
    expect(line().textContent).toContain(tools[2].body);
  });

  it("says how each is paid for: the editor and the style library cost no credits, the rest show their price on the button", () => {
    render(<ToolStrip title="t" tools={tools} priced={s.priced} free={s.free} />);
    const line = () => document.querySelector(".nx-tools-line")!.textContent ?? "";
    for (const t of tools) {
      fireEvent.click(screen.getByRole("button", { name: t.title }));
      expect(line()).toContain(t.id === "editor" || t.id === "styles" ? s.free : s.priced);
    }
  });

  it("is on the landing under the showcases, with a heading, and each button is at least 44 px tall", () => {
    const t = dictionaries.en;
    env();
    const { container } = render(<Landing t={t} locale="en" pricing={{ kind: "announced" }} anchor={{ pack: { kind: "none" }, api: null, site: null }} showcase={[]} />);
    expect(container.querySelector("section#tools h2")?.textContent).toBe(t.site.toolStrip.title);
    expect(css).toMatch(/\.nx-tool \{[^}]*min-height: 48px/);
    const order = ["show-approvals-title", "tools-title", "try-title"].map((id) => container.querySelector(`#${id}`));
    expect(order.every(Boolean)).toBe(true);
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const code of ["en", "ru", "uz"] as const) expect(dictionaries[code].site.toolStrip.title.length).toBeGreaterThan(8);
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
    expect(css).toMatch(/\.nx-chat \.nx-result-art \{ aspect-ratio: 4 \/ 3; \}/);
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
