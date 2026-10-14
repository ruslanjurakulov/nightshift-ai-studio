// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { I18nProvider } from "@/lib/i18n/context";
import { SkipLink } from "@/components/shell/SkipLink";
import { ScrollToTop } from "@/components/navigation/ScrollToTop";
import { revealCurrentTab } from "@/components/navigation/SectionTabs";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("skip link", () => {
  it.each([
    ["en", en],
    ["ru", ru],
    ["uz", uz],
  ] as const)("is the first link, points at #main and speaks %s", (locale, dict) => {
    const { container } = render(
      <I18nProvider locale={locale}>
        <SkipLink />
      </I18nProvider>,
    );
    const a = container.querySelector("a.app-skip") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("#main");
    expect(a.textContent).toBe(dict.landing.nav.skip);
    expect(a.textContent!.length).toBeGreaterThan(3);
  });

  it("the app's <main> is its target, in both layouts, and the link is drawn before the sidebar", () => {
    const layout = read("app/(app)/layout.tsx");
    expect(layout.match(/<main id="main" tabIndex=\{-1\}/g)).toHaveLength(2);
    expect(layout.indexOf("<SkipLink />")).toBeGreaterThan(-1);
    expect(layout.indexOf("<SkipLink />")).toBeLessThan(layout.indexOf("<SideNav"));
    expect(layout.indexOf("<SkipLink />")).toBeLessThan(layout.indexOf("{header}"));
  });

  it("is hidden until focused, 44px, with a focus ring", () => {
    const css = read("app/(app)/app-redesign.css");
    const rule = css.match(/\.app-skip \{[^}]*\}/)![0];
    expect(rule).toMatch(/top: -\d+px/);
    expect(rule).toMatch(/min-height: 44px/);
    const focus = css.match(/\.app-skip:focus,\s*\.app-skip:focus-visible \{[^}]*\}/)![0];
    expect(focus).toMatch(/outline: 3px solid/);
    expect(focus).toMatch(/top: max\(10px/);
  });
});

describe("section tabs: the current tab is scrolled into view", () => {
  function strip(navRect: [number, number], tabRect: [number, number]) {
    const nav = document.createElement("nav");
    const tab = document.createElement("a");
    tab.setAttribute("aria-current", "page");
    nav.appendChild(tab);
    nav.getBoundingClientRect = () => ({ left: navRect[0], right: navRect[1] }) as DOMRect;
    tab.getBoundingClientRect = () => ({ left: tabRect[0], right: tabRect[1] }) as DOMRect;
    nav.scrollLeft = 100;
    const scrollTo = vi.fn();
    nav.scrollTo = scrollTo as unknown as typeof nav.scrollTo;
    return { nav, scrollTo };
  }
  const mm = (reduce: boolean) =>
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: reduce }) as MediaQueryList,
    });

  it("scrolls right when the tab runs past the edge, sideways only", () => {
    mm(false);
    const { nav, scrollTo } = strip([0, 320], [250, 400]);
    revealCurrentTab(nav, true);
    expect(scrollTo).toHaveBeenCalledWith({ left: 100 + 400 - 320 + 8, behavior: "smooth" });
  });

  it("scrolls left when the tab starts before the edge", () => {
    mm(false);
    const { nav, scrollTo } = strip([0, 320], [-60, 40]);
    revealCurrentTab(nav, true);
    expect(scrollTo).toHaveBeenCalledWith({ left: 100 - 60 - 8, behavior: "smooth" });
  });

  it("does nothing when the tab is already visible", () => {
    mm(false);
    const { nav, scrollTo } = strip([0, 320], [20, 120]);
    revealCurrentTab(nav, true);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("can reveal a tab that was only focused, not current", () => {
    mm(false);
    const { nav, scrollTo } = strip([0, 320], [-60, 40]);
    const other = document.createElement("a");
    other.getBoundingClientRect = () => ({ left: 330, right: 420 }) as DOMRect;
    nav.appendChild(other);
    revealCurrentTab(nav, false, other);
    expect(scrollTo).toHaveBeenCalledWith({ left: 100 + 420 - 320 + 8, behavior: "auto" });
  });

  it("jumps instead of gliding for reduced motion and on arrival", () => {
    mm(true);
    const a = strip([0, 320], [250, 400]);
    revealCurrentTab(a.nav, true);
    expect(a.scrollTo.mock.calls[0][0].behavior).toBe("auto");
    mm(false);
    const b = strip([0, 320], [250, 400]);
    revealCurrentTab(b.nav, false);
    expect(b.scrollTo.mock.calls[0][0].behavior).toBe("auto");
  });
});

describe("back to top steps out of the way", () => {
  function setup() {
    let y = 0;
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const { container } = render(
      <I18nProvider locale="en">
        <ScrollToTop dock />
      </I18nProvider>,
    );
    const btn = container.querySelector("button.scroll-top") as HTMLButtonElement;
    const scrollTo = (to: number) =>
      act(() => {
        y = to;
        window.dispatchEvent(new Event("scroll"));
      });
    return { btn, scrollTo };
  }

  it("stays hidden while reading down, appears after scrolling back up on a long page", () => {
    const { btn, scrollTo } = setup();
    scrollTo(3000);
    expect(btn.dataset.hidden).toBe("true");
    // hidden is visual only: still reachable by keyboard and not aria-hidden
    expect(btn.tabIndex).toBe(0);
    expect(btn.hasAttribute("aria-hidden")).toBe(false);
    scrollTo(2990);
    expect(btn.dataset.hidden).toBe("true");
    scrollTo(2900);
    expect(btn.dataset.hidden).toBeUndefined();
    scrollTo(3300);
    expect(btn.dataset.hidden).toBe("true");
    vi.unstubAllGlobals();
  });

  it("never shows on a short page, even scrolling up", () => {
    const { btn, scrollTo } = setup();
    scrollTo(900);
    scrollTo(700);
    expect(btn.dataset.hidden).toBe("true");
    vi.unstubAllGlobals();
  });

  it("a focused 'hidden' button shows itself", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\.scroll-top\[data-hidden="true"\]:focus-visible \{[^}]*opacity: 1;[^}]*pointer-events: auto;/);
  });

  it("is still 44px, the page keeps its end clear of it, and the library's action bar owns its strip", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\.scroll-top \{[^}]*width: 2\.75rem;[^}]*height: 2\.75rem;/);
    expect(css).toMatch(/\.pad-page-tabbar \{ padding-bottom: calc\(7\.5rem/);
    expect(css).toMatch(/\.app-shell:has\(\[data-bottom-bar\]\) \.scroll-top \{ visibility: hidden; \}/);
    expect(read("components/media/MediaLibrary.tsx")).toContain("data-bottom-bar");
  });
});

describe("scroll padding on the whole shell", () => {
  const css = read("app/globals.css");
  it("keeps focus clear of the sticky top bar at every size, and the editor's taller rule still wins", () => {
    const shell = css.indexOf("html:has(.app-shell) { scroll-padding-top: calc(var(--ns-shell-h, 4rem) + 0.5rem); }");
    const editor = css.indexOf("html:has([data-editor-preview-pin]) {");
    expect(shell).toBeGreaterThan(-1);
    expect(editor).toBeGreaterThan(shell);
    // the pinned-preview rule keeps its min-height condition (short viewports have a static preview)
    expect(css.slice(css.lastIndexOf("@media", editor), editor)).toContain("(min-height: 32.01rem)");
  });
  it("measures the bar and publishes the token", () => {
    expect(read("components/shell/ShellOffsets.tsx")).toContain('"--ns-shell-h"');
    expect(read("app/(app)/layout.tsx")).toContain("<ShellOffsets />");
  });
});

describe("the shortcuts list says it scrolls", () => {
  it("the scroll area carries the CSS-only cue, on a solid ground", () => {
    expect(read("components/editor/TimelineViewBar.tsx")).toMatch(/className="scroll-cue [^"]*overflow-y-auto/);
    const css = read("app/(app)/app-redesign.css");
    const rule = css.match(/\.scroll-cue \{[^}]*\}/)![0];
    expect(rule).toContain("local");
    expect(rule).toContain("var(--color-panel)");
  });
});
