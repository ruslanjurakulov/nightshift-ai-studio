/**
 * The Ads section is listed only while NIGHTSHIFT_ADS_FACTORY is on, and the page is a 404 while it is off.
 * What would break without these: a rail entry or a Studio tab that links to a 404, the switch read in the browser (a NEXT_PUBLIC
 * value compiled in at build time), a caller that forgets to pass the switches showing the link anyway, and the page reading the
 * organization or the database while the switch is off.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CUSTOMER_SECTIONS, NO_NAV_FEATURES, SECTION_TABS, navGroupsFor, navShown, sectionAllowed, tabsFor } from "../lib/navigation";
import { isSection } from "../lib/channels";
import { ICONS } from "../components/navigation/navIcons";

const ON = { adsFactory: true };
const keys = (operator: boolean, features = NO_NAV_FEATURES) => navGroupsFor(operator, features).flatMap((g) => g.items.map((i) => i.key));

describe("navigation", () => {
  it("lists Ads for the operator only while the switch is on, and never by default", () => {
    expect(keys(true)).not.toContain("ads");
    expect(keys(true, { adsFactory: false })).not.toContain("ads");
    expect(keys(true, ON)).toContain("ads");
    expect(keys(true, ON).filter((k) => k !== "ads")).toEqual(keys(true));
  });

  it("lists Ads as a Studio tab only while the switch is on; the other tabs are untouched", () => {
    expect(tabsFor("create")?.items.map((i) => i.key)).not.toContain("ads");
    expect(tabsFor("create", ON)?.items.map((i) => i.key)).toContain("ads");
    expect(tabsFor("create", ON)?.items.filter((i) => i.key !== "ads")).toEqual(tabsFor("create")?.items);
    expect(SECTION_TABS.hub.some((i) => i.key === "ads")).toBe(true);
    expect(tabsFor("ads", ON)?.rail).toBe("hub");
  });

  it("the customer rail stays the five destinations either way", () => {
    expect(keys(false, ON)).toEqual(keys(false));
  });

  it("is a customer section (not operator-only), a known section, and has an icon", () => {
    expect(CUSTOMER_SECTIONS).toContain("ads");
    expect(sectionAllowed("ads", false)).toBe(true);
    expect(isSection("ads")).toBe(true);
    expect(ICONS.ads).toBeTruthy();
    expect(navShown("ads")).toBe(false);
    expect(navShown("ads", ON)).toBe(true);
    expect(navShown("styles")).toBe(true);
  });

  it("the switch is read on the server, in the layout and the sections page, and never as a NEXT_PUBLIC value", () => {
    const root = join(__dirname, "..");
    const layout = readFileSync(join(root, "app", "(app)", "layout.tsx"), "utf8");
    expect(layout).toContain("features={{ adsFactory: adsFactoryEnabled() }}");
    expect(readFileSync(join(root, "app", "(app)", "[channel]", "sections", "page.tsx"), "utf8")).toContain("navGroupsFor(true, { adsFactory: adsFactoryEnabled() })");
    for (const f of ["components/SideNav.tsx", "components/navigation/SectionTabs.tsx", "lib/adsFactory/flag.ts", "components/shell/ShellContext.tsx"]) {
      expect(readFileSync(join(root, f), "utf8"), f).not.toMatch(/NEXT_PUBLIC_[A-Z_]*ADS/);
    }
  });
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/components/ads/AdsWorkspace", () => ({ AdsWorkspace: () => null }));
vi.mock("@/components/ads/ads.css", () => ({}));
vi.mock("@/components/NotConfigured", () => ({ NotConfigured: () => null }));
vi.mock("@/components/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("@/components/g3/Section", () => ({ Note: () => null }));

const h = vi.hoisted(() => ({ org: vi.fn(), load: vi.fn(), client: vi.fn() }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: h.org }));
vi.mock("@/lib/server/ads-factory", () => ({ loadAdsWorkspace: h.load }));
vi.mock("@/lib/supabase/server", () => ({ createClient: h.client }));
vi.mock("@/lib/channels-path-server", () => ({ getChannelPath: async () => (s: string) => `/alpha${s}` }));

import type { ReactElement } from "react";
function flatten(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => flatten(n, out));
  else if (node && typeof node === "object" && "props" in (node as object)) {
    out.push(node as ReactElement);
    flatten((node as ReactElement<{ children?: unknown }>).props.children, out);
  }
  return out;
}

describe("the page", () => {
  beforeEach(() => {
    delete process.env.NIGHTSHIFT_ADS_FACTORY;
    h.org.mockReset().mockResolvedValue({ supported: true, orgs: [], current: { id: "o1", role: "editor" } });
    h.load.mockReset().mockResolvedValue({ available: true, kits: [], campaigns: [] });
    h.client.mockReset().mockResolvedValue({});
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is a 404 while the switch is off and reads nothing", async () => {
    const { default: Page } = await import("../app/(app)/[channel]/ads/page");
    for (const v of [undefined, "", "off", "enabled"]) {
      if (v === undefined) delete process.env.NIGHTSHIFT_ADS_FACTORY;
      else vi.stubEnv("NIGHTSHIFT_ADS_FACTORY", v);
      await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(h.org).not.toHaveBeenCalled();
    expect(h.load).not.toHaveBeenCalled();
    expect(h.client).not.toHaveBeenCalled();
  });

  it("with the switch on, reads the open organization's workspace and lets an editor change it", async () => {
    vi.stubEnv("NIGHTSHIFT_ADS_FACTORY", "on");
    const { default: Page } = await import("../app/(app)/[channel]/ads/page");
    const ws = flatten(await Page()).find((n) => (n.props as { orgId?: string }).orgId);
    expect(ws?.props).toMatchObject({ orgId: "o1", canEdit: true, libraryHref: "/alpha/library" });
    expect(h.load).toHaveBeenCalledWith({}, "o1", { urls: true });
  });

  it("a viewer gets the workspace without its buttons; no organization gets a note and no read", async () => {
    vi.stubEnv("NIGHTSHIFT_ADS_FACTORY", "on");
    const { default: Page } = await import("../app/(app)/[channel]/ads/page");
    h.org.mockResolvedValue({ supported: true, orgs: [], current: { id: "o1", role: "viewer" } });
    expect(flatten(await Page()).find((n) => (n.props as { orgId?: string }).orgId)?.props).toMatchObject({ canEdit: false });
    h.load.mockClear();
    h.org.mockResolvedValue({ supported: true, orgs: [], current: null });
    expect(flatten(await Page()).find((n) => (n.props as { orgId?: string }).orgId)).toBeUndefined();
    expect(h.load).not.toHaveBeenCalled();
  });
});
