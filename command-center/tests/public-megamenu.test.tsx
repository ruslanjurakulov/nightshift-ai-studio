// @vitest-environment jsdom
/**
 * The public header's panels (components/legal/PublicMegaMenu.tsx) and the phone sheet's sections
 * (components/legal/PublicMenu.tsx), drawn from one source (lib/public-nav.ts).
 *
 * What would break without these: a trigger only a mouse can open (the reference site's triggers take no focus); a panel
 * that flashes open as the pointer crosses the bar, or snaps shut on the diagonal down to it; two panels open at once; a
 * link that lands on a generic page instead of the one it names (the reference's "Creative Studio" links: 4 of 5 went to
 * the same app home); a link to a page that does not exist or is not public; a string missing in one language.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
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

import { dictionaries, LOCALES } from "@/lib/i18n";
import { publicDictionary } from "@/lib/i18n/public";
import { PublicI18nProvider } from "@/lib/i18n/public-context";
import { PublicShell } from "@/components/legal/PublicShell";
import { CLOSE_DELAY_MS, MegaMenu, MegaNav, MegaPanels, OPEN_DELAY_MS } from "@/components/legal/PublicMegaMenu";
import { isCurrentPage, menuHref, menuPath, navHrefs, publicNav, type NavEntry } from "@/lib/public-nav";
import { isPublicPath } from "@/lib/public-paths";
import { DEV_PAGE_PATHS } from "@/lib/dev-pages";
import { SOLUTION_IDS } from "@/lib/solutions";
import { APP_HOME } from "@/lib/session-hint";
import { publicMenuPaths } from "@/lib/public-nav-paths";
import { megaMenuEn } from "@/lib/i18n/megamenu/en";
import { megaMenuRu } from "@/lib/i18n/megamenu/ru";
import { megaMenuUz } from "@/lib/i18n/megamenu/uz";

const ROOT = process.cwd();

// jsdom has no PointerEvent: without one a test could not tell a mouse from a finger.
class FakePointerEvent extends MouseEvent {
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "mouse";
  }
}
(window as unknown as { PointerEvent: typeof FakePointerEvent }).PointerEvent = FakePointerEvent;

/** The media the page is "on": a mouse that can hover, at desktop width, unless a test says otherwise. */
let canHover = true;
beforeEach(() => {
  canHover = true;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("hover: hover") ? canHover : query.includes("min-width: 768px"),
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
  vi.useRealTimers();
});

function renderShell(locale: "en" | "ru" | "uz" = "en") {
  const t = dictionaries[locale];
  return render(
    <PublicI18nProvider locale={locale} t={publicDictionary(t)}>
      <PublicShell t={t}>
        <p>Behind the header</p>
      </PublicShell>
    </PublicI18nProvider>,
  );
}

const nav = () => document.querySelector<HTMLElement>("header.st-header nav.st-nav")!;
const trigger = (name: string) => within(nav()).getByRole("button", { name });
const panelOf = (b: HTMLElement) => document.getElementById(b.getAttribute("aria-controls")!)!;
const frame = () => document.querySelector<HTMLElement>(".st-mm")!;
const isOpen = (b: HTMLElement) => b.getAttribute("aria-expanded") === "true" && !panelOf(b).hidden && frame().getAttribute("data-open") === "true";
const links = (b: HTMLElement) => [...panelOf(b).querySelectorAll<HTMLAnchorElement>("a[href]")];
const openTriggers = () => [...nav().querySelectorAll("button[aria-expanded='true']")];

describe("the desktop panels: keyboard", () => {
  it("every trigger is a focusable <button> naming the panel it controls, closed at first (a disclosure, not role=menu)", () => {
    renderShell();
    const buttons = [...nav().querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Studio", "Solutions", "Developers", "Resources"]);
    for (const b of buttons) {
      expect(b.type).toBe("button");
      expect(b.getAttribute("aria-expanded")).toBe("false");
      expect(panelOf(b).getAttribute("aria-labelledby")).toBe(b.id);
      expect(b.getAttribute("role")).toBeNull();
    }
    expect(document.querySelector('[role="menu"], [role="menuitem"]')).toBeNull();
    // Closed, the frame is inert: nothing in it takes focus or is read.
    expect(frame().hasAttribute("inert")).toBe(true);
    // Pricing stays a plain link, no panel.
    expect(within(nav()).getByRole("link", { name: "Pricing" }).getAttribute("href")).toBe("/pricing");
  });

  it("Enter opens and closes with focus staying on the trigger; Space does too", () => {
    renderShell();
    const b = trigger("Solutions");
    b.focus();
    fireEvent.keyDown(b, { key: "Enter" });
    expect(isOpen(b)).toBe(true);
    expect(frame().hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b, { key: "Enter" });
    expect(b.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(b, { key: " " });
    expect(isOpen(b)).toBe(true);
  });

  it("ArrowDown opens and moves focus to the first link; ArrowUp to the last", () => {
    renderShell();
    const b = trigger("Developers");
    b.focus();
    fireEvent.keyDown(b, { key: "ArrowDown" });
    expect(isOpen(b)).toBe(true);
    expect(document.activeElement).toBe(links(b)[0]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.keyDown(b, { key: "ArrowUp" });
    expect(document.activeElement).toBe(links(b).at(-1));
  });

  it("Escape closes and returns focus to the trigger", () => {
    renderShell();
    const b = trigger("Studio");
    b.focus();
    fireEvent.keyDown(b, { key: "ArrowDown" });
    expect(panelOf(b).contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(b);
  });

  it("Up and Down move within the panel, Up from the first link goes back to the trigger, Home and End jump", () => {
    renderShell();
    const b = trigger("Studio");
    b.focus();
    fireEvent.keyDown(b, { key: "ArrowDown" });
    const all = links(b);
    expect(all.length).toBeGreaterThan(2);
    fireEvent.keyDown(all[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(all[1]);
    fireEvent.keyDown(all[1], { key: "ArrowUp" });
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(all[0], { key: "End" });
    expect(document.activeElement).toBe(all.at(-1));
    fireEvent.keyDown(all.at(-1)!, { key: "Home" });
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(all[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(b);
    expect(isOpen(b)).toBe(true);
  });

  it("Left and Right move between the bar's items, and carry an open panel along", () => {
    renderShell();
    const studio = trigger("Studio");
    studio.focus();
    fireEvent.keyDown(studio, { key: "Enter" });
    fireEvent.keyDown(studio, { key: "ArrowRight" });
    const solutions = trigger("Solutions");
    expect(document.activeElement).toBe(solutions);
    expect(isOpen(solutions)).toBe(true);
    expect(openTriggers()).toEqual([solutions]);
    // On to Pricing, a plain link: the panel closes.
    fireEvent.keyDown(solutions, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("href")).toBe("/pricing");
    expect(openTriggers()).toEqual([]);
  });

  it("Tab from an open trigger enters its panel; Shift+Tab from the first link returns; Tab past the last link moves on and closes", () => {
    renderShell();
    const b = trigger("Resources");
    b.focus();
    fireEvent.keyDown(b, { key: "Enter" });
    fireEvent.keyDown(b, { key: "Tab" });
    const all = links(b);
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(all[0], { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(b);
    all.at(-1)!.focus();
    fireEvent.keyDown(all.at(-1)!, { key: "Tab" });
    expect(b.getAttribute("aria-expanded")).toBe("false");
    // Resources is the bar's last item: Tab goes on to the first control after the nav, not back into the bar.
    expect(nav().contains(document.activeElement)).toBe(false);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("focus leaving the header, or a press outside it, closes the panel", () => {
    renderShell();
    const b = trigger("Studio");
    fireEvent.keyDown(b, { key: "Enter" });
    expect(isOpen(b)).toBe(true);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    act(() => outside.focus());
    expect(b.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(b, { key: "Enter" });
    fireEvent.pointerDown(screen.getByText("Behind the header"));
    expect(b.getAttribute("aria-expanded")).toBe("false");
    outside.remove();
  });
});

describe("the desktop panels: a two-column panel", () => {
  const entries: NavEntry[] = [
    {
      kind: "group",
      id: "studio",
      label: "Two",
      section: null,
      columns: [
        { id: "a", title: "A", links: [{ href: "/a1", label: "a1" }, { href: "/a2", label: "a2" }, { href: "/a3", label: "a3" }] },
        { id: "b", title: "B", links: [{ href: "/b1", label: "b1" }, { href: "/b2", label: "b2" }] },
      ],
    },
  ];
  it("Right and Left move between columns, keeping the row where the next column has one", () => {
    render(
      <MegaMenu entries={entries} current={null}>
        <header className="st-header">
          <MegaNav label="Main" />
          <MegaPanels />
        </header>
      </MegaMenu>,
    );
    const b = screen.getByRole("button", { name: "Two" });
    b.focus();
    fireEvent.keyDown(b, { key: "ArrowDown" });
    const a = (h: string) => document.querySelector<HTMLElement>(`.st-mm a[href="${h}"]`)!;
    expect(document.activeElement).toBe(a("/a1"));
    fireEvent.keyDown(a("/a1"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(a("/b1"));
    fireEvent.keyDown(a("/b1"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(a("/b2"));
    fireEvent.keyDown(a("/b2"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(a("/a2"));
    a("/a3").focus();
    fireEvent.keyDown(a("/a3"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(a("/b2"));
    // No column to the right of the last: focus stays.
    fireEvent.keyDown(a("/b2"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(a("/b2"));
  });
});

describe("the desktop panels: pointer", () => {
  const enter = (el: HTMLElement, pointerType = "mouse") => fireEvent.pointerEnter(el, { pointerType });
  const leave = (el: HTMLElement, pointerType = "mouse") => fireEvent.pointerLeave(el, { pointerType });

  it(`opens on hover only after ${OPEN_DELAY_MS}ms of rest, and a pointer passing across opens nothing`, () => {
    vi.useFakeTimers();
    renderShell();
    const b = trigger("Solutions");
    enter(b);
    act(() => vi.advanceTimersByTime(OPEN_DELAY_MS - 1));
    expect(b.getAttribute("aria-expanded")).toBe("false");
    act(() => vi.advanceTimersByTime(1));
    expect(isOpen(b)).toBe(true);

    cleanup();
    renderShell();
    const c = trigger("Studio");
    enter(c);
    act(() => vi.advanceTimersByTime(60));
    leave(c);
    enter(trigger("Solutions"));
    act(() => vi.advanceTimersByTime(60));
    leave(trigger("Solutions"));
    act(() => vi.advanceTimersByTime(1000));
    expect(openTriggers()).toEqual([]);
  });

  it(`stays open on the way from the trigger down into the panel (the ${CLOSE_DELAY_MS}ms close delay), and closes after leaving both`, () => {
    vi.useFakeTimers();
    renderShell();
    const b = trigger("Developers");
    enter(b);
    act(() => vi.advanceTimersByTime(OPEN_DELAY_MS));
    expect(isOpen(b)).toBe(true);
    leave(b);
    act(() => vi.advanceTimersByTime(CLOSE_DELAY_MS - 50));
    enter(frame());
    act(() => vi.advanceTimersByTime(2000));
    expect(isOpen(b)).toBe(true);
    leave(frame());
    act(() => vi.advanceTimersByTime(CLOSE_DELAY_MS - 1));
    expect(isOpen(b)).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(b.getAttribute("aria-expanded")).toBe("false");
  });

  it("only one panel is open, and moving to another trigger switches at once (no second delay)", () => {
    vi.useFakeTimers();
    renderShell();
    const studio = trigger("Studio");
    enter(studio);
    act(() => vi.advanceTimersByTime(OPEN_DELAY_MS));
    leave(studio);
    const solutions = trigger("Solutions");
    enter(solutions);
    expect(isOpen(solutions)).toBe(true);
    expect(openTriggers()).toEqual([solutions]);
    expect(panelOf(studio).hidden).toBe(true);
    act(() => vi.advanceTimersByTime(1000));
    expect(openTriggers()).toEqual([solutions]);
  });

  it("a click on the trigger the hover already opened keeps it open (pinned: leaving no longer closes it)", () => {
    vi.useFakeTimers();
    renderShell();
    const b = trigger("Studio");
    enter(b);
    act(() => vi.advanceTimersByTime(OPEN_DELAY_MS));
    fireEvent.click(b);
    expect(isOpen(b)).toBe(true);
    leave(b);
    act(() => vi.advanceTimersByTime(1000));
    expect(isOpen(b)).toBe(true);
    fireEvent.click(b);
    expect(b.getAttribute("aria-expanded")).toBe("false");
  });

  it("touch: no hover-open, a tap toggles", () => {
    vi.useFakeTimers();
    renderShell();
    const b = trigger("Solutions");
    enter(b, "touch");
    act(() => vi.advanceTimersByTime(1000));
    expect(b.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(b);
    expect(isOpen(b)).toBe(true);
    leave(b, "touch");
    act(() => vi.advanceTimersByTime(1000));
    expect(isOpen(b)).toBe(true);
    fireEvent.click(b);
    expect(b.getAttribute("aria-expanded")).toBe("false");
  });

  it("a screen that cannot hover (pointer: coarse) opens nothing on a pointer passing over", () => {
    vi.useFakeTimers();
    canHover = false;
    renderShell();
    enter(trigger("Studio"));
    act(() => vi.advanceTimersByTime(1000));
    expect(openTriggers()).toEqual([]);
  });
});

describe("motion and layout (components/site/site.css)", () => {
  const css = readFileSync(path.join(ROOT, "components/site/site.css"), "utf8");
  const rule = (sel: string) => new RegExp(`(?:^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m").exec(css)?.[1] ?? null;

  it("the frame overlays the page under the bar (absolute, full width) and is clipped and faded, never resized", () => {
    const base = rule(".st-mm") ?? "";
    expect(base).toMatch(/position:\s*absolute/);
    expect(base).toMatch(/top:\s*100%/);
    expect(base).toMatch(/left:\s*0/);
    expect(base).toMatch(/right:\s*0/);
    expect(base).not.toMatch(/height/);
    expect(base).not.toMatch(/transition/);
    // The header is the frame's anchor at every width that draws it.
    expect(css).toMatch(/@media \(max-width: 1023px\) \{ \.st-header \{ position: relative; \} \}/);
  });

  it("moves only with prefers-reduced-motion: no-preference, and not at all under the site's Pause motion", () => {
    const block = /@media \(prefers-reduced-motion: no-preference\) \{\n  \.st-mm \{ transition:[\s\S]*?\n\}/.exec(css)?.[0] ?? "";
    expect(block).toMatch(/\.st-mm \{ transition: opacity 300ms/);
    expect(block).toMatch(/html\[data-motion="paused"\] \.st-mm, html\[data-motion="paused"\] \.st-mm\[data-open="true"\], html\[data-motion="paused"\] \.st-mm-chev \{ transition: none; \}/);
    // Outside that block nothing in the menu transitions.
    const chev = /@media \(prefers-reduced-motion: no-preference\) \{\n  \.st-menu-chev \{ transition:[\s\S]*?\n\}/.exec(css)?.[0] ?? "";
    expect(chev).toMatch(/html\[data-motion="paused"\] \.st-menu-chev \{ transition: none; \}/);
    const rest = css.replace(block, "").replace(chev, "");
    expect(rest).not.toMatch(/\.st-mm[^{]*\{[^}]*transition:\s*(opacity|clip-path)/);
    expect(rest).not.toMatch(/\.st-menu-chev \{[^}]*transition/);
  });

  it("44px rows on a coarse pointer, and the trigger keeps a 44px target without wrapping", () => {
    expect(css).toMatch(/@media \(pointer: coarse\) \{ \.st-mm-link, \.st-mm-title \{ min-height: 44px; \} \}/);
    const t = rule(".st-nav .st-mm-trigger") ?? "";
    expect(t).toMatch(/min-height:\s*44px/);
    expect(t).toMatch(/white-space:\s*nowrap/);
    expect(t).toMatch(/font-size:\s*15px/);
    expect(t).toMatch(/font-weight:\s*500/);
  });
});

/** The route file a path is served by, or null (dynamic solution pages are only their listed ids). */
function routeFile(p: string): string | null {
  if (p === "/") return "app/page.tsx";
  const direct = `app${p}/page.tsx`;
  if (existsSync(path.join(ROOT, direct))) return direct;
  const m = /^\/solutions\/([^/]+)$/.exec(p);
  if (m && (SOLUTION_IDS as readonly string[]).includes(m[1])) return "app/solutions/[slug]/page.tsx";
  return null;
}

/** A section a page always renders: where each anchor the menu points at is drawn. */
function anchorDrawn(p: string, hash: string): boolean {
  const src = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
  if (p === "/") return src("components/landing/home/HomePage.tsx").includes(`id="${hash}"`);
  if (p === "/studio") return dictionaries.en.site.studioPage.hero.jump.some((j) => j.id === hash) && src("components/site/StudioPage.tsx").includes("<Head id=");
  if (p === "/docs/api") return new RegExp(`SECTION_IDS = \\[[^\\]]*"${hash}"`).test(src("components/docs/ApiDocs.tsx"));
  return false;
}

describe("the panels list only what exists, each link its own destination", () => {
  for (const locale of LOCALES.map((l) => l.code)) {
    for (const devPages of [false, true]) {
      it(`${locale}, CLI pages ${devPages ? "on" : "off"}: every href is distinct, a route file, public, and its #section is drawn`, () => {
        const hrefs = navHrefs(publicNav(dictionaries[locale], { devPages }));
        expect(new Set(hrefs).size).toBe(hrefs.length);
        for (const h of hrefs) {
          const [p, hash] = h.split("#");
          expect(routeFile(p), h).not.toBeNull();
          const pub = isPublicPath(p) || (devPages && (DEV_PAGE_PATHS as readonly string[]).includes(p));
          expect(pub, `${h} is public`).toBe(true);
          if (hash !== undefined) expect(anchorDrawn(p, hash), `${h}: #${hash} is drawn`).toBe(true);
          // Never a generic landing standing in for a named page: not sign-up, not the app's home.
          expect(["/signup", "/login", APP_HOME]).not.toContain(p);
        }
        if (!devPages) for (const d of DEV_PAGE_PATHS) expect(hrefs).not.toContain(d);
      });
    }
  }

  it("the drawn panels and the drawn sheet each link every destination exactly once, the same set", () => {
    renderShell();
    const expected = navHrefs(publicNav(dictionaries.en, { devPages: false }));
    const inPanels = [...document.querySelectorAll(".st-mm a[href]")].map((a) => a.getAttribute("href"));
    const inBar = [...nav().querySelectorAll(":scope > a[href]")].map((a) => a.getAttribute("href"));
    const sheetNav = document.querySelector(".st-menu-nav")!;
    const inSheet = [...sheetNav.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
    const desktop = [...inPanels, ...inBar];
    expect(new Set(desktop).size).toBe(desktop.length);
    expect(new Set(inSheet).size).toBe(inSheet.length);
    expect([...desktop].sort()).toEqual([...expected].sort());
    expect([...inSheet].sort()).toEqual([...expected].sort());
  });

  // The localised public paths (/ru/…, /uz/…) will come as one change to menuHref (lib/public-nav.ts); a link drawn around it
  // would stay on the un-prefixed page in every language.
  it("every public href the header, the panels and the sheet draw goes through menuHref", () => {
    for (const f of ["components/legal/PublicShell.tsx", "components/legal/PublicMegaMenu.tsx", "components/legal/PublicMenu.tsx"]) {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      const hrefs = [...src.matchAll(/\bhref=(\{[^}]*\}\)?\}?|"[^"]*")/g)].map((m) => m[1]);
      expect(hrefs.length, f).toBeGreaterThan(0);
      // Allowed outside it: the skip link (#main, this page) and the app's home (not a public page; it has no language prefix).
      for (const h of hrefs) expect(h.startsWith("{menuHref(") || h === '"#main"' || h === "{APP_HOME}", `${f}: href=${h}`).toBe(true);
    }
  });

  it("publicMenuPaths is the whole list the header draws: the menu's destinations plus the wordmark, Sign in and Start free", () => {
    for (const devPages of [false, true]) {
      const all = publicMenuPaths({ devPages });
      expect(new Set(all).size).toBe(all.length);
      expect(all).toEqual(expect.arrayContaining(navHrefs(publicNav(dictionaries.en, { devPages }))));
      expect(all.slice(0, 3)).toEqual(["/", "/login", "/signup"]);
      for (const h of all) expect(routeFile(h.split("#")[0]), h).not.toBeNull();
    }
    renderShell();
    const drawn = [...document.querySelectorAll("header.st-header a[href]")]
      .map((a) => a.getAttribute("href")!)
      .filter((h) => h !== "#main");
    expect(new Set(drawn)).toEqual(new Set(publicMenuPaths({ devPages: false })));
  });

  it("the lit item is matched on the normalised path, and a #section link is never the page itself", () => {
    expect(isCurrentPage("/mcp", "/mcp")).toBe(true);
    expect(isCurrentPage("/docs/api#pricing", "/docs/api")).toBe(false);
    expect(isCurrentPage("/docs/api", "/docs/api")).toBe(true);
    expect(isCurrentPage("/trust", "/roadmap")).toBe(false);
    // Identity until the localised paths land (then splitLocalePath(pathname).path and localeHref).
    expect(menuPath("/solutions/developers")).toBe("/solutions/developers");
    expect(menuHref("/pricing")).toBe("/pricing");
  });

  it("no Download panel, no badges or countdowns: the bar is four triggers and Pricing", () => {
    renderShell();
    const items = [...nav().querySelectorAll(":scope > a, :scope > button")].map((e) => e.textContent);
    expect(items).toEqual(["Studio", "Solutions", "Pricing", "Developers", "Resources"]);
    expect(document.querySelector(".st-mm")!.textContent).not.toMatch(/download|new\b|soon|%|\d+:\d+/i);
  });
});

describe("the copy", () => {
  const keys = (o: object, pre = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v, `${pre}${k}.`) : [`${pre}${k}`]));
  const values = (o: object): string[] => Object.values(o).flatMap((v) => (v && typeof v === "object" ? values(v) : [v as string]));

  it("has the same keys in en, ru and uz, none empty, and is what the site dictionary carries", () => {
    expect(keys(megaMenuRu)).toEqual(keys(megaMenuEn));
    expect(keys(megaMenuUz)).toEqual(keys(megaMenuEn));
    for (const d of [megaMenuEn, megaMenuRu, megaMenuUz]) for (const v of values(d)) expect(v.trim()).not.toBe("");
    expect(dictionaries.en.site.megaMenu).toBe(megaMenuEn);
    expect(dictionaries.ru.site.megaMenu).toBe(megaMenuRu);
    expect(dictionaries.uz.site.megaMenu).toBe(megaMenuUz);
  });

  it("Uzbek uses the modifier letters (oʻ U+02BB, ʼ U+02BC), never an ASCII or typographic apostrophe", () => {
    for (const v of values(megaMenuUz)) expect(v, v).not.toMatch(/['`‘’]/);
    expect(values(megaMenuUz).join(" ")).toContain("ʻ");
  });

  it("every label in every language comes from a dictionary: no English is left in the ru or uz menus", () => {
    for (const locale of ["ru", "uz"] as const) {
      const ours = navHrefs(publicNav(dictionaries[locale], { devPages: false }));
      expect(ours).toEqual(navHrefs(publicNav(dictionaries.en, { devPages: false })));
      const labels = publicNav(dictionaries[locale], { devPages: false }).flatMap((e) =>
        e.kind === "link" ? [e.label] : [e.label, ...e.columns.flatMap((c) => [c.title, ...c.links.flatMap((l) => [l.label, l.description ?? ""])])],
      );
      for (const english of ["Resources", "API pricing", "What we are building next"]) expect(labels).not.toContain(english);
    }
  });
});

describe("the phone sheet's sections", () => {
  it("each group is a button that expands and collapses its links, starting collapsed off its own page", () => {
    renderShell();
    fireEvent.click(document.querySelector<HTMLButtonElement>(".st-menu-btn")!);
    const sheet = screen.getByRole("dialog", { name: "Menu" });
    const sec = within(sheet).getByRole("button", { name: "Developers" });
    const body = document.getElementById(sec.getAttribute("aria-controls")!)!;
    expect(sec.getAttribute("aria-expanded")).toBe("false");
    expect(body.hidden).toBe(true);
    fireEvent.click(sec);
    expect(sec.getAttribute("aria-expanded")).toBe("true");
    expect(body.hidden).toBe(false);
    expect(within(body).getByRole("link", { name: "MCP" }).getAttribute("href")).toBe("/mcp");
    fireEvent.click(sec);
    expect(body.hidden).toBe(true);
    // Pricing is a plain link in the sheet too.
    expect(within(sheet).getByRole("link", { name: "Pricing" }).getAttribute("href")).toBe("/pricing");
  });

  it("the focus trap skips a collapsed section's links, and the primary key is the sheet's last stop (pinned at its foot)", () => {
    renderShell();
    const button = document.querySelector<HTMLButtonElement>(".st-menu-btn")!;
    fireEvent.click(button);
    const sheet = screen.getByRole("dialog", { name: "Menu" });
    const key = sheet.querySelector<HTMLAnchorElement>(".st-menu-foot a.st-key")!;
    expect(key.getAttribute("href")).toBe("/signup");
    key.focus();
    fireEvent.keyDown(sheet, { key: "Tab" });
    expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "Close menu" }));
    fireEvent.keyDown(sheet, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(key);
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(document.activeElement).toBe(button);
  });

  it("the chevron turns only with motion allowed, and the sheet is the whole phone screen", () => {
    const css = readFileSync(path.join(ROOT, "components/site/site.css"), "utf8");
    expect(css).toMatch(/\.st-menu-sec-btn\[aria-expanded="true"\] \.st-menu-chev \{ transform: rotate\(180deg\); \}/);
    expect(css).toMatch(/html\[data-motion="paused"\] \.st-menu-chev \{ transition: none; \}/);
    expect(css).toMatch(/@media \(max-width: 767px\) \{ \.st-menu-sheet \{ width: 100%;/);
  });
});
