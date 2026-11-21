/**
 * Character Studio is listed only while NIGHTSHIFT_CHARACTER_STUDIO is on, and its page is a 404 while it is off.
 * What would break without these: a rail entry or a Studio tab that links to a 404, the switch read in the browser (a NEXT_PUBLIC
 * value compiled in at build time), and the page reading the organization or the database while the switch is off.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_NAV_FEATURES, navGroupsFor, navShown, sectionAllowed, studioTilesFor, tabsFor } from "../lib/navigation";
import { isSection } from "../lib/channels";
import { ICONS } from "../components/navigation/navIcons";

const ON = { adsFactory: false, characterStudio: true };
const keys = (operator: boolean, features = NO_NAV_FEATURES) => navGroupsFor(operator, features).flatMap((g) => g.items.map((i) => i.key));

describe("navigation", () => {
  it("lists Character Studio (a Studio home tile, never a rail entry) only while its switch is on, and never by default", () => {
    expect(keys(true)).not.toContain("characterStudio");
    expect(keys(true, ON)).not.toContain("characterStudio");
    const tiles = (features = NO_NAV_FEATURES) => studioTilesFor(true, features).map((x) => x.key);
    expect(tiles()).not.toContain("characterStudio");
    expect(tiles(ON)).toContain("characterStudio");
    expect(tiles(ON).filter((k) => k !== "characterStudio")).toEqual(tiles());
    expect(tabsFor("character-studio", ON)?.rail).toBe("studio");
    expect(navShown("characterStudio")).toBe(false);
    expect(navShown("characterStudio", ON)).toBe(true);
  });

  it("is a customer section, a known section, and has an icon", () => {
    expect(sectionAllowed("characterStudio", false)).toBe(true);
    expect(isSection("character-studio")).toBe(true);
    expect(ICONS.characterStudio).toBeTruthy();
  });

  it("the switch is read on the server only", () => {
    const root = join(__dirname, "..");
    for (const f of ["components/character-studio/CharacterStudio.tsx", "components/character-studio/TemplateCard.tsx", "lib/characterStudio/model.ts"]) {
      expect(readFileSync(join(root, f), "utf8"), f).not.toMatch(/NEXT_PUBLIC_[A-Z_]*CHARACTER/);
    }
    expect(readFileSync(join(root, "components/character-studio/CharacterStudio.tsx"), "utf8")).not.toContain("process.env");
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
vi.mock("@/components/character-studio/CharacterStudio", () => ({ CharacterStudio: () => null }));
vi.mock("@/components/character-studio/character-studio.css", () => ({}));
vi.mock("@/components/NotConfigured", () => ({ NotConfigured: () => null }));
vi.mock("@/components/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("@/components/g3/Section", () => ({ Note: () => null }));

const h = vi.hoisted(() => ({ org: vi.fn(), load: vi.fn(), client: vi.fn() }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: h.org }));
vi.mock("@/lib/server/character-studio", () => ({ loadStudio: h.load }));
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
    delete process.env.NIGHTSHIFT_CHARACTER_STUDIO;
    h.org.mockReset().mockResolvedValue({ supported: true, orgs: [], current: { id: "o1", role: "editor" } });
    h.load.mockReset().mockResolvedValue({ available: true, templates: [], jobs: [], videos: [], pictures: [] });
    h.client.mockReset().mockResolvedValue({});
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is a 404 while the switch is off and reads nothing", async () => {
    const { default: Page } = await import("../app/(app)/[channel]/character-studio/page");
    for (const v of [undefined, "", "off", "enabled"]) {
      if (v === undefined) delete process.env.NIGHTSHIFT_CHARACTER_STUDIO;
      else vi.stubEnv("NIGHTSHIFT_CHARACTER_STUDIO", v);
      await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(h.org).not.toHaveBeenCalled();
    expect(h.load).not.toHaveBeenCalled();
    expect(h.client).not.toHaveBeenCalled();
  });

  it("with the switch on, reads the open organization's studio; a viewer gets it without the button", async () => {
    vi.stubEnv("NIGHTSHIFT_CHARACTER_STUDIO", "on");
    const { default: Page } = await import("../app/(app)/[channel]/character-studio/page");
    const find = async () => flatten(await Page()).find((n) => (n.props as { orgId?: string }).orgId);
    expect((await find())?.props).toMatchObject({ enabled: true, orgId: "o1", canEdit: true, libraryHref: "/alpha/library" });
    expect(h.load).toHaveBeenCalledWith({}, "o1", { urls: true });
    h.org.mockResolvedValue({ supported: true, orgs: [], current: { id: "o1", role: "viewer" } });
    expect((await find())?.props).toMatchObject({ canEdit: false });
  });
});
