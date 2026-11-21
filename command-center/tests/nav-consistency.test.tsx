// @vitest-environment jsdom
/**
 * Owner, 2026-11-21: "sections are inconsistent between pages: they expand/collapse and their number changes".
 * Two causes, both pinned here:
 *  - the rail read the channel scope, so Research was listed on a channel's pages and dropped on all-channels;
 *  - /studio swapped in its own 76px icon rail (other labels, no collapse preference), so the sidebar looked collapsed there
 *    and expanded everywhere else.
 * A customer sees one rail, in one order with one set of labels, on every page and in every scope; the operator likewise.
 *
 * Widths: jsdom draws no layout, so "1440" and "390" are the window sizes the markup is rendered at; which of the sidebar
 * (lg and up) or the bottom bar (below lg) is visible is the CSS breakpoint's job. What is pinned is that each of the two is
 * the same list on every page at either size.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import type { ReactNode } from "react";

let pathname = "/chronos/home";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
vi.mock("@/components/navigation/NavigationProvider", () => ({
  useNavigation: () => ({ canGoBack: () => false, goBack: vi.fn(), channelName: () => null, showChannel: false }),
}));
vi.mock("@/lib/channels-client", () => ({
  // As the real hooks: the slug is the URL's first segment, and every link is built under it.
  useChannelSlug: () => pathname.split("/")[1],
  useChannelPath: () => (p: string) => `/${pathname.split("/")[1]}${p}`,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { SideNav } from "@/components/SideNav";
import { ShellProvider } from "@/components/shell/ShellContext";
import { SidebarProvider } from "@/components/shell/SidebarState";
import { SIDEBAR_KEY } from "@/lib/sidebar-pref";
import type { NavFeatures } from "@/lib/navigation";

const en = dictionaries.en;

/** The pages the owner compared, a channel's and the roll-up's. */
const PAGES = ["/chronos/home", "/chronos/studio", "/chronos/library", "/chronos/brain", "/all-channels/credits", "/chronos/settings", "/chronos/organization"];
const WIDTHS = [1440, 390];
// Seven full shell renders per test: well under a second alone, but past vitest's 5 s default on a loaded runner.
const SLOW = 20_000;

function shell(ui: ReactNode, { operator = false, features, collapsed = false }: { operator?: boolean; features?: NavFeatures; collapsed?: boolean } = {}) {
  return (
    <I18nProvider locale="en">
      <ShellProvider operator={operator} features={features}>
        <SidebarProvider initialCollapsed={collapsed}>{ui}</SidebarProvider>
      </ShellProvider>
    </I18nProvider>
  );
}

/** A link as the rail draws it, the channel taken off its href so two scopes can be compared. */
function entries(root: HTMLElement): string[] {
  return within(root)
    .getAllByRole("link")
    .map((a) => `${a.textContent}|${(a.getAttribute("href") ?? "").replace(/^\/[^/]+/, "")}`);
}

function customerRail(): string[] {
  const nav = screen.getByRole("navigation", { name: en.shell.primary });
  const aside = nav.closest("aside") as HTMLElement;
  // The rows and the foot (Plans & credits, Settings): the whole sidebar's link list, the user card aside.
  return entries(aside);
}

function bottomBar(): string[] {
  return entries(screen.getByRole("navigation", { name: en.nav.menu }));
}

// Node 22+ puts its own `localStorage` on the global, which is undefined without --localstorage-file and hides jsdom's.
// The shell must work either way; this test needs a working one, so it brings a plain in-memory store when there is none.
if (!globalThis.localStorage) {
  const m = new Map<string, string>();
  const store = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true });
}

beforeEach(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
  window.localStorage.clear();
  document.cookie = "ns_sidebar=; Max-Age=0; Path=/";
});
afterEach(cleanup);

describe("a customer sees one rail on every page and in every scope", () => {
  for (const width of WIDTHS) {
    for (const features of [undefined, { adsFactory: false, characterStudio: false, aiChat: true }] as const) {
      it(`the same sidebar and bottom bar on ${PAGES.length} pages at ${width}px (Nightshift AI ${features ? "on" : "off"})`, () => {
        window.innerWidth = width;
        const seen = PAGES.map((p) => {
          pathname = p;
          render(shell(<SideNav email="me@example.com" plan={null} />, { features }));
          const r = { page: p, rail: customerRail(), bar: bottomBar() };
          cleanup();
          return r;
        });
        for (const s of seen) {
          expect(s.rail, s.page).toEqual(seen[0].rail);
          expect(s.bar, s.page).toEqual(seen[0].bar);
        }
        // The list itself, so "identical" cannot mean "identically empty".
        // First the wordmark, the link to Home (named by its aria-label, no text of its own).
        expect(seen[0].rail[0]).toBe("|/home");
        expect(seen[0].rail.slice(1).map((e) => e.split("|")[0])).toEqual([
          en.nav.studio,
          ...(features ? [en.nav.nightshiftAi] : []),
          en.nav.library,
          en.nav.brain,
          en.nav.channels,
          en.nav.research,
          en.shell.plansCredits,
          en.nav.settings,
        ]);
        // The owner's decision: Analytics ("Tahlil") is not a customer entry, on any page.
        expect(seen[0].rail.some((e) => e.startsWith(`${en.nav.analytics}|`))).toBe(false);
      }, SLOW);
    }
  }

  it("on all-channels a channel entry stays and opens the roll-up's page (which asks for a channel), never vanishes", () => {
    pathname = "/all-channels/credits";
    render(shell(<SideNav email={null} plan={null} />));
    const nav = screen.getByRole("navigation", { name: en.shell.primary });
    expect(within(nav).getByRole("link", { name: en.nav.research }).getAttribute("href")).toBe("/all-channels/research");
  });

  it("Nightshift Studio keeps the same sidebar, not a narrower rail of its own", () => {
    pathname = "/chronos/studio";
    render(shell(<SideNav email={null} plan={null} />));
    expect(document.getElementById("customer-sidebar")).not.toBeNull();
    expect(document.querySelector("[data-studio-rail]")).toBeNull();
  });
});

describe("the operator's rail is the same on every page too", () => {
  it("Studio does not swap the console rail for a four-entry one", () => {
    const seen = PAGES.map((p) => {
      pathname = p;
      const { container } = render(shell(<SideNav operator />, { operator: true }));
      const aside = container.querySelector("aside") as HTMLElement;
      const r = { page: p, rail: aside ? entries(aside) : [] };
      cleanup();
      return r;
    });
    expect(seen[0].rail.length).toBeGreaterThan(4);
    for (const s of seen) expect(s.rail, s.page).toEqual(seen[0].rail);
  }, SLOW);
});

describe("collapsed or expanded survives navigation and reloads", () => {
  it("a collapse on Home is still a collapse on Studio, on all-channels and after a reload", () => {
    pathname = "/chronos/home";
    render(shell(<SideNav email={null} plan={null} />));
    act(() => {
      fireEvent.click(screen.getByTestId("sidebar-toggle"));
    });
    expect(document.getElementById("customer-sidebar")?.dataset.collapsed).toBe("true");
    // One key in the browser, mirrored to the cookie the server reads for the first frame.
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("collapsed");
    expect(document.cookie).toContain("ns_sidebar=collapsed");
    cleanup();

    // A reload or a hard navigation remounts the provider: the server drew the first frame from the cookie, so it starts
    // collapsed, and so does every page after it.
    for (const p of ["/chronos/studio", "/all-channels/credits", "/chronos/brain"]) {
      pathname = p;
      render(shell(<SideNav email={null} plan={null} />, { collapsed: true }));
      expect(document.getElementById("customer-sidebar")?.dataset.collapsed, p).toBe("true");
      cleanup();
    }
  });

  it("the server's first frame is already collapsed on every page, Studio included (no flash of the other state)", () => {
    for (const p of PAGES) {
      pathname = p;
      const html = renderToString(shell(<SideNav email={null} plan={null} />, { collapsed: true }));
      expect(html, p).toContain('id="customer-sidebar"');
      expect(html, p).toContain('data-collapsed="true"');
    }
  }, SLOW);

  it("a browser that refuses storage still lets the sidebar collapse for the visit", () => {
    const spy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      pathname = "/chronos/library";
      render(shell(<SideNav email={null} plan={null} />));
      act(() => {
        fireEvent.click(screen.getByTestId("sidebar-toggle"));
      });
      expect(document.getElementById("customer-sidebar")?.dataset.collapsed).toBe("true");
    } finally {
      spy.mockRestore();
    }
  });
});
