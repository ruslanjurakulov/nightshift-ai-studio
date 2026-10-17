// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";

const push = vi.fn();
let pathname = "/chronos/command-center";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push, refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
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
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";

const LOCALES: Locale[] = ["en", "ru", "uz"];
import { SideNav } from "@/components/SideNav";
import { Header } from "@/components/Header";
import { OwnerGlance } from "@/components/dashboard/OwnerGlance";
import {
  ALL_SECTIONS,
  OPERATOR_TABS,
  isOperatorOnlySection,
  navGroupsFor,
  operatorTabCurrent,
  sectionAllowed,
} from "@/lib/navigation";
import type { ChannelRow } from "@/lib/types";
import type { OrgSummary } from "@/lib/orgs";

const en = dictionaries.en;

function withI18n(ui: ReactNode, locale: Locale = "en") {
  return <I18nProvider locale={locale}>{ui}</I18nProvider>;
}

const ORGS: OrgSummary[] = [
  { id: "o1", name: "Nightshift Studio Holdings", slug: "nightshift", role: "owner", is_default: true } as OrgSummary,
  { id: "o2", name: "Customer Org With A Long Name", slug: "cust", role: "owner", is_default: false } as OrgSummary,
];
const CHANNELS = [
  { channel_id: "chronos", name: "Chronos Documentary Channel", niche: "history", status: "ACTIVE" },
  { channel_id: "extinct", name: "Extinct World", niche: "nature", status: "ACTIVE" },
] as unknown as ChannelRow[];

beforeEach(() => {
  pathname = "/chronos/command-center";
  push.mockClear();
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
});
afterEach(cleanup);

describe("the owner's phone navigation is visible, not a drawer", () => {
  it("shows five tabs with no menu to open: Home, Videos, Billing, Alerts, More", () => {
    render(withI18n(<SideNav operator />));
    const nav = screen.getByRole("navigation", { name: en.ownerShell.tabsLabel });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual([
      en.ownerShell.tabHome,
      en.ownerShell.tabVideos,
      en.ownerShell.tabBilling,
      en.ownerShell.tabAlerts,
      en.ownerShell.tabMore,
    ]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/chronos/command-center",
      "/chronos/videos",
      "/chronos/billing",
      "/chronos/alerts",
      "/chronos/sections",
    ]);
    // Nothing to press first: no hamburger/menu button and no dialog hiding the navigation.
    expect(screen.queryByRole("button", { name: new RegExp(`^(${en.nav.menu})$`, "i") })).toBeNull();
    expect(document.querySelector("[aria-haspopup]")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lights the tab for the page, and More for every other screen", () => {
    pathname = "/chronos/billing";
    const { unmount } = render(withI18n(<SideNav operator />));
    const nav = screen.getByRole("navigation", { name: en.ownerShell.tabsLabel });
    expect(within(nav).getByRole("link", { name: en.ownerShell.tabBilling }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: en.ownerShell.tabHome }).getAttribute("aria-current")).toBeNull();
    unmount();
    pathname = "/chronos/jobs";
    render(withI18n(<SideNav operator />));
    const more = screen.getByRole("link", { name: en.ownerShell.tabMore });
    expect(more.getAttribute("aria-current")).toBe("page");
  });

  it("operatorTabCurrent maps sections to tabs", () => {
    expect(operatorTabCurrent("/command-center")).toBe("home");
    expect(operatorTabCurrent("/videos/abc123")).toBe("videos");
    expect(operatorTabCurrent("/billing")).toBe("billing");
    expect(operatorTabCurrent("/alerts")).toBe("alerts");
    expect(operatorTabCurrent("/sections")).toBe("more");
    expect(operatorTabCurrent("/pipeline")).toBe("more");
  });

  it("a customer never gets the owner's bar", () => {
    render(withI18n(<SideNav email="me@example.com" plan={null} />));
    expect(screen.queryByRole("navigation", { name: en.ownerShell.tabsLabel })).toBeNull();
    expect(document.querySelector("[data-operator-tabbar]")).toBeNull();
    expect(document.querySelector('a[href$="/billing"], a[href$="/alerts"], a[href$="/sections"]')).toBeNull();
  });

  it("Billing, Alerts and More are operator screens a customer is bounced from (Home and Videos are shared)", () => {
    for (const tab of OPERATOR_TABS) {
      const section = tab.href.slice(1);
      if (tab.key === "home" || tab.key === "videos") {
        expect(sectionAllowed(section, false), tab.href).toBe(true);
        continue;
      }
      expect(isOperatorOnlySection(section), tab.href).toBe(true);
      expect(sectionAllowed(section, false), tab.href).toBe(false);
      expect(sectionAllowed(section, true), tab.href).toBe(true);
    }
    expect(ALL_SECTIONS).toBe("/sections");
  });

  it("the sections page lists everything the desktop rail does, so nothing is only reachable from the rail", () => {
    const rail = navGroupsFor(true).flatMap((g) => g.items.map((i) => i.href));
    expect(rail.length).toBeGreaterThan(30);
    // The page renders navGroupsFor(true) directly: pin that it is the operator's list.
    const src = readFileSync(path.join(__dirname, "..", "app", "(app)", "[channel]", "sections", "page.tsx"), "utf8");
    expect(src).toContain("navGroupsFor(true)");
    expect(src).toContain("isOperator()");
  });

  it("SideNav has no hamburger icon, drawer or Menu button left for the owner", () => {
    const src = readFileSync(path.join(__dirname, "..", "components", "SideNav.tsx"), "utf8");
    expect(src).not.toMatch(/from "lucide-react"[^;]*\bMenu\b|\{[^}]*\bMenu\b[^}]*\} from "lucide-react"/);
    expect(src).not.toContain("drawer-enter");
    expect(src).not.toContain("aria-haspopup");
  });
});

describe("the owner's phone header", () => {
  function header() {
    return render(
      withI18n(<Header operator orgs={ORGS} currentOrgId="o1" channels={CHANNELS} selection="chronos" email="owner@example.com" />),
    );
  }

  it("has one workspace button that reads the organization over the channel, and no 'Menu' button", () => {
    header();
    const btn = document.querySelector("[data-context-switcher]") as HTMLElement;
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain("Nightshift Studio Holdings");
    expect(btn.textContent).toContain("Chronos Documentary Channel");
    expect(btn.getAttribute("aria-label")).toContain(en.ownerShell.ctxLabel);
    expect(screen.queryByRole("button", { name: en.nav.menu })).toBeNull();
  });

  it("opens a sheet with the FULL names, and picking a channel keeps the screen", () => {
    pathname = "/chronos/billing";
    header();
    fireEvent.click(document.querySelector("[data-context-switcher]") as HTMLElement);
    const sheet = screen.getByRole("dialog", { name: en.ownerShell.ctxLabel });
    expect(within(sheet).getByText("Customer Org With A Long Name")).toBeTruthy();
    expect(within(sheet).getByText("Extinct World")).toBeTruthy();
    fireEvent.click(within(sheet).getByText("Extinct World"));
    expect(push).toHaveBeenCalledWith("/extinct-world/billing");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders no picker with a single organization and a single channel", () => {
    render(withI18n(<Header operator orgs={[ORGS[0]]} currentOrgId="o1" channels={[CHANNELS[0]]} selection="chronos" email="owner@example.com" />));
    expect(document.querySelector("[data-context-switcher]")).toBeNull();
  });
});

describe("owner shell copy", () => {
  it("is complete and the same shape in en, ru and uz", () => {
    const keys = (o: object) => Object.keys(o).sort();
    for (const loc of LOCALES) {
      const d = dictionaries[loc].ownerShell;
      expect(keys(d), loc).toEqual(keys(en.ownerShell));
      expect(keys(d.agentNames), loc).toEqual(keys(en.ownerShell.agentNames));
      for (const [k, v] of Object.entries(d)) {
        if (typeof v === "string") expect(v.trim(), `${loc}.${k}`).not.toBe("");
      }
      expect(dictionaries[loc].nav.allSections.trim()).not.toBe("");
    }
  });

  it("keeps the {n} placeholder, and speaks Russian and Uzbek rather than English", () => {
    for (const loc of ["ru", "uz"] as const) {
      const d = dictionaries[loc].ownerShell;
      expect(d.gWorkersSilent, loc).toContain("{n}");
      for (const k of ["tabHome", "tabVideos", "tabBilling", "tabAlerts", "tabMore", "gFailed", "gWaiting", "gAlerts", "gWorkers", "glanceLabel"] as const) {
        expect(d[k], `${loc}.${k}`).not.toBe(en.ownerShell[k]);
      }
    }
  });

  it("fits a tab: the longest short label is at most 9 characters in every language", () => {
    for (const loc of LOCALES) {
      const d = dictionaries[loc].ownerShell;
      for (const k of ["tabHome", "tabVideos", "tabBilling", "tabAlerts", "tabMore"] as const) {
        expect(d[k].length, `${loc}.${k}`).toBeLessThanOrEqual(9);
      }
    }
  });
});

describe("the Command Center strip", () => {
  it("shows an unreadable figure as unknown, never as 0, and every tile is a link", () => {
    render(
      <OwnerGlance
        label="At a glance"
        health={{ tone: "ok", text: "Healthy", detail: null, live: false }}
        unknown="unknown"
        tiles={[
          { key: "failed", href: "/chronos/errors", label: "Failed", value: null, tone: "idle" },
          { key: "waiting", href: "/chronos/videos", label: "Waiting", value: "0", sub: "none", tone: "ok" },
          { key: "alerts", href: "/chronos/alerts", label: "Alerts", value: "2", tone: "warn" },
        ]}
      />,
    );
    const strip = screen.getByRole("region", { name: "At a glance" });
    const links = within(strip).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/chronos/errors", "/chronos/videos", "/chronos/alerts"]);
    expect(links[0].textContent).toContain("unknown");
    expect(links[0].textContent).not.toMatch(/\b0\b/);
    expect(links[1].textContent).toContain("0");
    // Phone only: the desktop page carries these facts in its own figures and panels.
    expect(strip.className).toContain("lg:hidden");
  });
});
