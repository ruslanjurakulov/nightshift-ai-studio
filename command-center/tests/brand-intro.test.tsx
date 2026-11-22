// @vitest-environment jsdom
/**
 * The homepage's first-visit brand intro (lib/site/brand-intro.ts, components/site/BrandIntro.tsx). What would break without
 * these: the intro playing on every load, or for someone who asked for less motion, is on a metered or slow link, is signed in,
 * or is on another page; the page flashing before the cover, or the cover staying up when JavaScript fails; an input that does
 * not end it; the overlay taking focus or being read out; the timeline creeping past the owner's 1.8 s; or the N drifting from
 * the app icon's drawing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
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

import { BrandIntro } from "@/components/site/BrandIntro";
import { BRAND_MARK_ART } from "@/components/site/brandMarkArt";
import {
  BRAND_INTRO_SCRIPT,
  INTRO,
  INTRO_CLAIM_MS,
  INTRO_COVER_ATTR,
  INTRO_FALLBACK_MS,
  INTRO_HELD,
  INTRO_LATE_MS,
  INTRO_SAFETY_MS,
  INTRO_SEEN_KEY,
  INTRO_SWALLOW_MS,
  INTRO_TOTAL_MS,
  introBlocked,
} from "@/lib/site/brand-intro";
import { dictionaries } from "@/lib/i18n";
import { publicDictionary } from "@/lib/i18n/public";
import { PublicI18nProvider } from "@/lib/i18n/public-context";
import { PublicShell } from "@/components/legal/PublicShell";

const ROOT = process.cwd();
const html = document.documentElement;
const SESSION = "sb-abcdefghijklmnopqrst-auth-token";

let reduced = false;
function installMatchMedia() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reduced : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
function setConnection(c: { saveData?: boolean; effectiveType?: string } | undefined) {
  Object.defineProperty(navigator, "connection", { value: c, configurable: true });
}
function clearCookies() {
  for (const c of document.cookie.split(";")) {
    const name = c.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}
/** Runs the inline script exactly as the browser would, at the top of <body>. */
const runScript = () => new Function(BRAND_INTRO_SCRIPT)();
const covered = () => html.hasAttribute(INTRO_COVER_ATTR);
const overlay = () => document.querySelector<HTMLElement>("[data-testid='brand-intro']");
/** The opening's own animationend on the first half: how the overlay ends in a browser. */
const finishOpening = () => fireEvent.animationEnd(overlay()!.querySelector("[data-leaf='a']")!);
let visibility: DocumentVisibilityState = "visible";
/** A button on the page under the intro, counting its clicks. */
function pageButton() {
  const b = document.createElement("button");
  b.textContent = "Bring it to the Studio";
  const onClick = vi.fn();
  b.addEventListener("click", onClick);
  document.body.appendChild(b);
  return { b, onClick };
}

beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  installMatchMedia();
  setConnection(undefined);
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
  html.removeAttribute(INTRO_COVER_ATTR);
  html.removeAttribute("data-motion");
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { get: () => visibility, configurable: true });
  Object.defineProperty(document, "prerendering", { value: false, configurable: true });
});

afterEach(() => {
  cleanup();
  // Any listener a script run left behind removes itself on its first event.
  window.dispatchEvent(new Event("keydown"));
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearCookies();
  html.removeAttribute(INTRO_COVER_ATTR);
  document.body.querySelectorAll("button").forEach((b) => b.remove());
});

describe("the pre-hydration script", () => {
  it("puts the cover up on a first visit to / and marks the tab, so a second load gets none", () => {
    runScript();
    expect(covered()).toBe(true);
    expect(Number(html.getAttribute(INTRO_COVER_ATTR))).toBeGreaterThanOrEqual(0);
    expect(window.sessionStorage.getItem(INTRO_SEEN_KEY)).toBe("1");
    html.removeAttribute(INTRO_COVER_ATTR);
    runScript();
    expect(covered()).toBe(false);
  });

  const blocked: [string, () => void][] = [
    ["sessionStorage.getItem throws", () => vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); })],
    ["sessionStorage.setItem throws", () => vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); })],
    ["sessionStorage does not keep what it was given", () => vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {})],
    ["prefers-reduced-motion", () => { reduced = true; }],
    ["no matchMedia, so reduced motion cannot be ruled out", () => { (window as { matchMedia?: unknown }).matchMedia = undefined; }],
    ["Save-Data", () => setConnection({ saveData: true, effectiveType: "4g" })],
    ["slow-2g", () => setConnection({ effectiveType: "slow-2g" })],
    ["2g", () => setConnection({ effectiveType: "2g" })],
    ["3g", () => setConnection({ effectiveType: "3g" })],
    ["html[data-motion=paused]", () => html.setAttribute("data-motion", "paused")],
    ["Pause motion remembered for the tab", () => window.sessionStorage.setItem("ns-motion", "paused")],
    ["a signed-in visitor (the header's session hint)", () => { document.cookie = `${SESSION}=x; path=/`; }],
    ["a chunked session cookie", () => { document.cookie = `${SESSION}.0=x; path=/`; }],
    ["a path other than /", () => window.history.replaceState(null, "", "/pricing")],
    ["a crawler", () => vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (compatible; Googlebot/2.1)")],
    ["Bing's crawler", () => vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (compatible; bingbot/2.0)")],
    ["a hidden tab", () => { visibility = "hidden"; }],
    ["a prerender", () => Object.defineProperty(document, "prerendering", { value: true, configurable: true })],
  ];

  for (const [name, setup] of blocked) {
    it(`puts no cover up for ${name}`, () => {
      setup();
      runScript();
      expect(covered()).toBe(false);
    });

    // Writing the seen flag is the script's alone; the component never writes storage, so it has nothing to agree with there.
    if (name.startsWith("sessionStorage.setItem") || name.startsWith("sessionStorage does not")) continue;
    it(`agrees with the component's own check for ${name}`, () => {
      setup();
      expect(introBlocked()).toBe(true);
    });
  }

  it("agrees with the component's check on a 4G visit that may play", () => {
    setConnection({ saveData: false, effectiveType: "4g" });
    expect(introBlocked()).toBe(false);
    runScript();
    expect(covered()).toBe(true);
  });

  // Lab tools see what a first visitor sees; a phone brand that ends in "bot" is a person, not a crawler.
  for (const [name, ua] of [
    ["Lighthouse / PageSpeed", "Mozilla/5.0 (Linux; Android 11; moto g power) Chrome/120 Mobile Safari/537.36 Chrome-Lighthouse"],
    ["a CUBOT phone", "Mozilla/5.0 (Linux; Android 12; CUBOT P80) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36"],
  ]) {
    it(`plays for ${name}`, () => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
      expect(introBlocked()).toBe(false);
      runScript();
      expect(covered()).toBe(true);
    });
  }

  it("does not mark the tab seen when it decided not to play", () => {
    reduced = true;
    runScript();
    expect(window.sessionStorage.getItem(INTRO_SEEN_KEY)).toBeNull();
  });

  it("lifts an unclaimed cover itself at INTRO_LATE_MS: a slow phone sees ~0.3 s of black, then the page", () => {
    runScript();
    vi.advanceTimersByTime(INTRO_LATE_MS - 1);
    expect(covered()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(covered()).toBe(false);
  });

  it("leaves a claimed cover to the component, and lifts even that at the safety timeout", () => {
    runScript();
    html.setAttribute(INTRO_COVER_ATTR, INTRO_HELD);
    vi.advanceTimersByTime(INTRO_LATE_MS + 1);
    expect(covered()).toBe(true);
    vi.advanceTimersByTime(INTRO_SAFETY_MS - INTRO_LATE_MS);
    expect(covered()).toBe(false);
  });

  for (const e of ["pointerdown", "keydown", "wheel", "touchstart", "touchmove"]) {
    it(`lifts the cover at once on ${e} before hydration`, () => {
      runScript();
      window.dispatchEvent(new Event(e));
      expect(covered()).toBe(false);
    });
  }

  it("a claimed cover is lifted by an input too, so the component sees the visitor already chose the page", () => {
    window.sessionStorage.clear();
    runScript();
    html.setAttribute(INTRO_COVER_ATTR, INTRO_HELD);
    window.dispatchEvent(new Event("keydown"));
    expect(covered()).toBe(false);
  });

  it("does not take a scroll the browser made by itself (restoring a position, a #hash) as a skip", () => {
    runScript();
    window.dispatchEvent(new Event("scroll"));
    expect(covered()).toBe(true);
  });

  it("swallows the click of the tap that lifted the cover, once, so it cannot press what was under it", () => {
    const { b, onClick } = pageButton();
    runScript();
    fireEvent.pointerDown(b);
    expect(covered()).toBe(false);
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("stops swallowing after INTRO_SWALLOW_MS, and a key never swallows anything", () => {
    const { b, onClick } = pageButton();
    runScript();
    fireEvent.touchStart(b);
    vi.advanceTimersByTime(INTRO_SWALLOW_MS);
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
    window.sessionStorage.clear();
    runScript();
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("is plain ES5 that cannot close its own <script> tag", () => {
    expect(BRAND_INTRO_SCRIPT).not.toMatch(/<\/?script|=>|\blet\b|\bconst\b|`/i);
  });
});

describe("the overlay", () => {
  it("renders nothing without the cover (a later page, no script, a client navigation)", () => {
    render(<BrandIntro />);
    expect(overlay()).toBeNull();
  });

  it("plays once the script put the cover up, takes the cover over, and leaves the DOM when the opening ends", () => {
    runScript();
    render(<BrandIntro />);
    expect(overlay()).not.toBeNull();
    expect(covered()).toBe(false);
    // A busy main thread delays the animation; the overlay waits for it rather than cutting its end on a clock.
    act(() => vi.advanceTimersByTime(INTRO_TOTAL_MS));
    expect(overlay()).not.toBeNull();
    act(() => {
      finishOpening();
    });
    expect(overlay()).toBeNull();
  });

  it("leaves anyway after INTRO_FALLBACK_MS when no animationend comes (a tab hidden mid-intro)", () => {
    runScript();
    render(<BrandIntro />);
    act(() => vi.advanceTimersByTime(INTRO_FALLBACK_MS - 1));
    expect(overlay()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(overlay()).toBeNull();
  });

  it("after it ended, a tap on the page is the page's: nothing left over swallows it", () => {
    const { b, onClick } = pageButton();
    runScript();
    render(<BrandIntro />);
    act(() => {
      finishOpening();
    });
    fireEvent.pointerDown(b);
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("plays once per tab: a reload in the same tab gets the page directly", () => {
    runScript();
    const first = render(<BrandIntro />);
    act(() => {
      finishOpening();
    });
    first.unmount();
    runScript();
    render(<BrandIntro />);
    expect(overlay()).toBeNull();
  });

  for (const [name, fire] of [
    ["a click", (el: HTMLElement) => fireEvent.click(el)],
    ["a pointer down", (el: HTMLElement) => fireEvent.pointerDown(el)],
    ["a key", () => fireEvent.keyDown(window, { key: "Tab" })],
    ["a wheel", () => fireEvent.wheel(window)],
    ["a touch", (el: HTMLElement) => fireEvent.touchStart(el)],
    ["a finger moving", (el: HTMLElement) => fireEvent.touchMove(el)],
  ] as [string, (el: HTMLElement) => void][]) {
    it(`ends at once on ${name}, straight to the end state`, () => {
      runScript();
      render(<BrandIntro />);
      const el = overlay()!;
      act(() => fire(el));
      expect(overlay()).toBeNull();
      expect(covered()).toBe(false);
    });
  }

  it("a tap that skips does not also press the button under it", () => {
    const { b, onClick } = pageButton();
    runScript();
    render(<BrandIntro />);
    act(() => {
      fireEvent.pointerDown(overlay()!);
    });
    expect(overlay()).toBeNull();
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(INTRO_SWALLOW_MS));
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("a programmatic scroll does not end it", () => {
    runScript();
    render(<BrandIntro />);
    act(() => {
      fireEvent.scroll(window);
    });
    expect(overlay()).not.toBeNull();
  });

  it("is aria-hidden, holds nothing focusable, and never moves focus", () => {
    const before = document.createElement("a");
    before.href = "#main";
    before.textContent = "Skip";
    document.body.appendChild(before);
    before.focus();
    runScript();
    render(<BrandIntro />);
    const el = overlay()!;
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.querySelectorAll("a, button, input, select, textarea, [tabindex]")).toHaveLength(0);
    for (const svg of el.querySelectorAll("svg")) expect(svg.getAttribute("focusable")).toBe("false");
    expect(document.activeElement).toBe(before);
    expect(document.body.hasAttribute("inert")).toBe(false);
    before.remove();
  });

  it("lifts the cover and does not play when the visitor is now blocked (reduced motion turned on before hydration)", () => {
    runScript();
    reduced = true;
    render(<BrandIntro />);
    expect(overlay()).toBeNull();
    expect(covered()).toBe(false);
  });

  it("does not start when hydration arrived too late: the page is simply there", () => {
    runScript();
    html.setAttribute(INTRO_COVER_ATTR, String(Math.round(performance.now() - INTRO_LATE_MS - 50)));
    render(<BrandIntro />);
    expect(overlay()).toBeNull();
    expect(covered()).toBe(false);
  });

  it("does not claim a cover whose own CSS lift is about to start: no black put back over a page already showing", () => {
    runScript();
    html.setAttribute(INTRO_COVER_ATTR, String(Math.round(performance.now() - INTRO_CLAIM_MS - 20)));
    render(<BrandIntro />);
    expect(overlay()).toBeNull();
    expect(covered()).toBe(false);
  });

  it("the cover lifts itself in CSS at INTRO_LATE_MS (off the main thread), unless claimed", () => {
    const css = readFileSync(path.join(ROOT, "components/site/brand-intro.css"), "utf8");
    const rule = /html\[data-ns-intro\] body::before \{[^}]*animation: ns-intro-cover-lift (\d+)ms [a-z-]+ (\d+)ms forwards;/.exec(css);
    expect(rule).not.toBeNull();
    expect(Number(rule![2])).toBe(INTRO_LATE_MS);
    expect(css).toMatch(/html\[data-ns-intro="held"\] body::before \{\s*animation: none;/);
    expect(INTRO_CLAIM_MS).toBeLessThanOrEqual(INTRO_LATE_MS - 50);
  });

  it("starts from its beginning when it takes over, so nobody sees the logo already half faded in", () => {
    runScript();
    html.setAttribute(INTRO_COVER_ATTR, String(Math.round(performance.now() - INTRO_CLAIM_MS + 20)));
    render(<BrandIntro />);
    const el = overlay()!;
    expect(el.style.getPropertyValue("--ns-in-at")).toBe(`${INTRO.inAt}ms`);
    expect(el.style.getPropertyValue("--ns-open-at")).toBe(`${INTRO.openAt}ms`);
  });

  it("draws the N with the app icon's ns-n path, byte for byte, and the header's lettering", () => {
    const icon = readFileSync(path.join(ROOT, "app/icon.svg"), "utf8");
    const nsN = /<clipPath id="ns-n"><path d="([^"]+)"\/><\/clipPath>/.exec(icon)?.[1];
    expect(nsN).toBeTruthy();
    expect(BRAND_MARK_ART.outline).toBe(nsN);
    runScript();
    render(<BrandIntro />);
    const el = overlay()!;
    const mark = el.querySelector("svg[data-wordmark='mark']")!;
    expect(mark.querySelector("path")!.getAttribute("d")).toBe(nsN);
    expect(el.querySelector("svg[data-wordmark='full'] [data-letters]")).not.toBeNull();
  });
});

describe("the timeline", () => {
  it("is over within the owner's 1.8 s, every phase inside it", () => {
    expect(INTRO_TOTAL_MS).toBeLessThanOrEqual(1800);
    const phases = [
      [INTRO.inAt, INTRO.inMs],
      [INTRO.wipeAt, INTRO.wipeMs],
      [INTRO.slitAt, INTRO.slitMs],
      [INTRO.openAt, INTRO.openMs],
    ];
    for (const [at, ms] of phases) {
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at + ms).toBeLessThanOrEqual(INTRO_TOTAL_MS);
    }
    // In order: in, then the lettering goes, then the slit, then the opening.
    expect(INTRO.wipeAt).toBeGreaterThanOrEqual(INTRO.inAt + INTRO.inMs);
    expect(INTRO.slitAt).toBeGreaterThan(INTRO.wipeAt);
    expect(INTRO.openAt).toBeGreaterThan(INTRO.slitAt);
    expect(INTRO.inMs).toBeLessThanOrEqual(320);
  });

  it("the safety timeout never cuts a running intro, and a late start is refused before it could", () => {
    expect(INTRO_LATE_MS).toBeLessThan(INTRO_SAFETY_MS);
    expect(INTRO_LATE_MS).toBeLessThan(INTRO.openAt);
    // Nobody stands on bare black for longer than about a blink before either the logo or the page.
    expect(INTRO_LATE_MS).toBeLessThanOrEqual(300);
    expect(INTRO_FALLBACK_MS).toBeGreaterThan(INTRO_TOTAL_MS);
  });
});

describe("where it is mounted", () => {
  const shell = (intro: boolean) =>
    renderToStaticMarkup(
      <PublicI18nProvider locale="en" t={publicDictionary(dictionaries.en)}>
        <PublicShell t={dictionaries.en} fresh intro={intro}>
          <h1>Hero</h1>
        </PublicShell>
      </PublicI18nProvider>,
    );

  it("server-renders the script, never the overlay: crawlers and no-JS visitors get the page as it is", () => {
    const markup = shell(true);
    expect(markup).toContain(`<script>${BRAND_INTRO_SCRIPT}</script>`);
    expect(markup).not.toContain("ns-intro-leaf");
    expect(markup).toContain("<h1>Hero</h1>");
    // First in the shell, ahead of the skip link and the header, so nothing paints before it decides.
    expect(markup.indexOf("<script>")).toBeLessThan(markup.indexOf("st-skip"));
  });

  it("is on no other public page", () => {
    expect(shell(false)).not.toContain(BRAND_INTRO_SCRIPT);
  });

  it("only the homepage asks for it", () => {
    const page = readFileSync(path.join(ROOT, "app/page.tsx"), "utf8");
    expect(page).toContain("<PublicShell t={t} fresh intro>");
  });
});
