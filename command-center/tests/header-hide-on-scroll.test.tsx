// @vitest-environment jsdom
/**
 * The public header gets out of the way (components/site/motion/attach.ts attachHeader, components/site/site-motion.css).
 * The owner's report, 2026-11-14: at 1440 px the sticky bar sat over the section heading "Made with Nightshift", its lower
 * half showing through the 74 % glass, cut in two. What would break if any of these failed:
 * - the bar would sit over the heading a reader scrolled down to (it must slide away going down, and come back going up);
 * - a keyboard user tabbing into the bar, or anyone with its language list or menu open, would have it slide away under them;
 * - a reader who asked for less motion would see it slide;
 * - the bar, back over the page, would let the text under it read through again;
 * - a #section link would land with its heading under the bar.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => {
    const { prefetch, ...attrs } = rest;
    void prefetch;
    return (
      <a href={href} {...attrs}>
        {children}
      </a>
    );
  },
}));

import { dictionaries } from "@/lib/i18n";
import { publicDictionary } from "@/lib/i18n/public";
import { PublicI18nProvider } from "@/lib/i18n/public-context";
import { PublicShell } from "@/components/legal/PublicShell";
import { HEADER_DOWN, HEADER_HIDE_AFTER, HEADER_SHOW_ABOVE, HEADER_UP, attachHeader } from "@/components/site/motion/attach";

const ROOT = join(__dirname, "..");
const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const motionCss = noComments(readFileSync(join(ROOT, "components/site/site-motion.css"), "utf8"));
const siteCss = noComments(readFileSync(join(ROOT, "components/site/site.css"), "utf8"));

/** The text of every `@media (...) { ... }` block whose query contains this text (the reader tests/site-motion.test.tsx uses). */
function mediaBlocks(source: string, needle: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf("@media", from);
    if (at < 0) return out;
    const open = source.indexOf("{", at);
    const query = source.slice(at, open);
    let depth = 0;
    let end = open;
    for (; end < source.length; end++) {
      if (source[end] === "{") depth++;
      else if (source[end] === "}" && --depth === 0) break;
    }
    if (query.includes(needle)) out.push(source.slice(open + 1, end));
    from = end + 1;
  }
}

let y = 0;
/** Scroll the window to `to` and let the throttled listener's frame run. */
function scrollTo(to: number) {
  y = to;
  window.dispatchEvent(new Event("scroll"));
}
/** A wheel run: many small steps, as a real scroll arrives. */
function scrollBy(delta: number, step = 4) {
  const target = y + delta;
  const dir = Math.sign(delta);
  while (dir > 0 ? y < target : y > target) scrollTo(dir > 0 ? Math.min(target, y + step) : Math.max(target, y - step));
}

function header(): HTMLElement {
  return document.querySelector("header.st-header") as HTMLElement;
}
const isHidden = () => header().hasAttribute("data-hidden");

beforeEach(() => {
  y = 0;
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
  // One frame per scroll, run at once: the listener's throttle is still exercised (a second event in the same frame is dropped).
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("style");
});

/** A bare header with a link and a language button, the parts the script looks at. */
function bareHeader() {
  document.body.innerHTML = `
    <header class="st-header"><div class="st-header-row">
      <a href="/#how" id="how">How it works</a>
      <button id="lang" aria-haspopup="listbox" aria-expanded="false">EN</button>
    </div></header>
    <main><a href="#x" id="page-link">On the page</a></main>`;
}

describe("the public header slides away going down and comes back going up", () => {
  it("is shown at the top, hidden once scrolled down past the threshold, shown again after a real scroll up", () => {
    bareHeader();
    const stop = attachHeader();
    expect(isHidden()).toBe(false);
    scrollBy(HEADER_HIDE_AFTER + 400);
    expect(isHidden()).toBe(true);
    // The heading the reader scrolled to is not under the bar: the bar is out of view, by a transform (site-motion.css below).
    scrollBy(-(HEADER_UP - 4));
    expect(isHidden(), "a few pixels of settling is not a scroll up").toBe(true);
    scrollBy(-8);
    expect(isHidden()).toBe(false);
    scrollBy(HEADER_DOWN + 4);
    expect(isHidden()).toBe(true);
    stop();
  });

  it("never hides near the top, and does not flicker in the band under the threshold", () => {
    bareHeader();
    const stop = attachHeader();
    scrollBy(HEADER_HIDE_AFTER);
    expect(isHidden(), "at the threshold, not past it").toBe(false);
    scrollBy(40);
    expect(isHidden()).toBe(true);
    // Back into the band between HEADER_SHOW_ABOVE and HEADER_HIDE_AFTER by small steps, then jitter there.
    scrollTo(HEADER_SHOW_ABOVE + 10);
    expect(isHidden(), "a scroll up of more than HEADER_UP brings it back").toBe(false);
    for (const at of [HEADER_SHOW_ABOVE + 14, HEADER_SHOW_ABOVE + 11, HEADER_SHOW_ABOVE + 15, HEADER_SHOW_ABOVE + 12]) scrollTo(at);
    expect(isHidden(), "jitter in the band does not hide it").toBe(false);
    scrollTo(HEADER_SHOW_ABOVE);
    expect(isHidden()).toBe(false);
    stop();
  });

  it("listens passively, at most once per frame, and lets go of everything on cleanup", () => {
    bareHeader();
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    const stop = attachHeader();
    const scroll = add.mock.calls.find((c) => c[0] === "scroll");
    expect(scroll?.[2]).toEqual({ passive: true });
    y = 400;
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event("scroll"));
    expect(frames.length, "five events in one frame queue one frame").toBe(1);
    frames.shift()!(0);
    expect(isHidden()).toBe(true);
    stop();
    expect(remove.mock.calls.some((c) => c[0] === "scroll" && c[1] === scroll?.[1])).toBe(true);
    expect(isHidden(), "cleanup leaves no hidden bar behind").toBe(false);
    expect(document.documentElement.style.getPropertyValue("--st-header-h")).toBe("");
  });

  it("stays shown while its language list (or any menu in it) is open", () => {
    bareHeader();
    const stop = attachHeader();
    document.getElementById("lang")!.setAttribute("aria-expanded", "true");
    scrollBy(600);
    expect(isHidden()).toBe(false);
    document.getElementById("lang")!.setAttribute("aria-expanded", "false");
    scrollBy(40);
    expect(isHidden(), "closed again, the next scroll down hides it").toBe(true);
    stop();
  });

  it("stays shown with keyboard focus inside it, and comes back the moment the keyboard enters it", () => {
    bareHeader();
    const stop = attachHeader();
    const how = document.getElementById("how")!;
    how.focus();
    scrollBy(600);
    expect(isHidden()).toBe(false);
    how.blur();
    scrollBy(40);
    expect(isHidden()).toBe(true);
    // Tab from the page into the hidden bar.
    how.focus();
    expect(isHidden()).toBe(false);
    stop();
  });

  it("does not stay pinned by a mouse click on a link (focus without :focus-visible), or every nav click would keep it over the page", () => {
    bareHeader();
    const real = HTMLElement.prototype.matches;
    vi.spyOn(HTMLElement.prototype, "matches").mockImplementation(function (this: HTMLElement, sel: string) {
      return sel === ":focus-visible" ? false : real.call(this, sel);
    });
    const stop = attachHeader();
    document.getElementById("how")!.focus();
    scrollBy(600);
    expect(isHidden()).toBe(true);
    stop();
  });

  it("publishes the bar's height for the page's scroll-padding", () => {
    bareHeader();
    Object.defineProperty(header(), "offsetHeight", { configurable: true, value: 69 });
    const stop = attachHeader();
    expect(document.documentElement.style.getPropertyValue("--st-header-h")).toBe("69px");
    stop();
  });
});

describe("on the real public frame", () => {
  function renderShell() {
    const t = dictionaries.en;
    return render(
      <PublicI18nProvider locale="en" t={publicDictionary(t)}>
        <PublicShell t={t} fresh>
          <h2 id="samples-title">Made with Nightshift</h2>
        </PublicShell>
      </PublicI18nProvider>,
    );
  }

  it("hides the shell's header going down and shows it going up (SiteMotion mounts the script)", () => {
    renderShell();
    expect(isHidden()).toBe(false);
    scrollBy(800);
    expect(isHidden()).toBe(true);
    scrollBy(-40);
    expect(isHidden()).toBe(false);
  });

  it("keeps the header shown while the phone menu is open", () => {
    renderShell();
    const menu = screen.getByRole("button", { name: dictionaries.en.site.nav.menu });
    fireEvent.click(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    scrollBy(800);
    expect(isHidden()).toBe(false);
  });

  it("keeps the header shown while the language list is open", () => {
    renderShell();
    const lang = header().querySelector<HTMLElement>('.st-header-desk [aria-haspopup="listbox"]')!;
    fireEvent.click(lang);
    expect(lang.getAttribute("aria-expanded")).toBe("true");
    lang.blur();
    scrollBy(800);
    expect(isHidden()).toBe(false);
  });
});

describe("the header's CSS", () => {
  const wide = mediaBlocks(motionCss, "min-width: 1024px").join("\n");

  it("slides out with a transform only, so the sticky box keeps its place (no CLS), and only while hidden", () => {
    expect(wide).toMatch(/\.st \.st-header\[data-hidden\] \{ transform: translateY\(-100%\); \}/);
    // A transform on the bar at rest would make it the containing block of the fixed phone-menu sheet inside it.
    expect(motionCss).not.toMatch(/\.st-header(?:\[data-scrolled\])? \{[^}]*\btransform\s*:/);
    expect(motionCss).not.toMatch(/\.st-header\[data-hidden\][^{]*\{[^}]*(?:height|padding|margin|top|display|position)\s*:/);
  });

  it("slides in 200 to 250 ms with motion allowed, and has no transition at all under reduced motion", () => {
    const allowed = mediaBlocks(motionCss, "prefers-reduced-motion: no-preference").join("\n");
    const m = allowed.match(/\.st \.st-header \{ transition: transform (\d+)ms var\(--ns-ease\); \}/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(200);
    expect(Number(m![1])).toBeLessThanOrEqual(250);
    let rest = motionCss;
    for (const inner of mediaBlocks(motionCss, "prefers-reduced-motion: no-preference")) rest = rest.replace(inner, "");
    expect(rest).not.toMatch(/\.st-header[^{]*\{[^}]*\btransition\s*:/);
  });

  it("is at least 92 % opaque when it is back over the page, in both themes (one token, --ns-ground), and keeps the blur", () => {
    const at = wide.indexOf(".st .st-header[data-scrolled]::before {");
    const rule = wide.slice(at, wide.indexOf("}", at));
    const mix = rule.match(/background-color: color-mix\(in srgb, var\(--ns-ground\) (\d+)%, transparent\);/);
    expect(mix, rule).not.toBeNull();
    expect(Number(mix![1])).toBeGreaterThanOrEqual(92);
    expect(rule).toMatch(/backdrop-filter: blur\(18px\)/);
  });

  it("lands a #section link below the bar: scroll-padding-top is the measured bar height plus air", () => {
    const wideSite = mediaBlocks(siteCss, "min-width: 1024px").join("\n");
    expect(wideSite).toContain("html:has(.st-header-row) { scroll-padding-top: calc(var(--st-header-h, 100px) + 12px); }");
  });
});
