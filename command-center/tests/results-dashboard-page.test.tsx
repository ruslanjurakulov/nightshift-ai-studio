/**
 * The results page behind NIGHTSHIFT_RESULTS_DASHBOARD (app/(app)/[channel]/analytics/results/page.tsx), called as a function with its
 * data layer scripted. What would break without these: the page rendering (or touching the database) while the switch is off,
 * a workspace without an organization seeing a dashboard, the page opening on a channel that is not the URL's, and a new
 * top-level section that breaks the navigation's one-label-per-section rule (tests/navigation.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SECTIONS, isSection } from "../lib/channels";

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
vi.mock("@/components/results/ResultsDashboard", () => ({ ResultsDashboard: () => null }));
vi.mock("@/components/results/results.css", () => ({}));
vi.mock("@/components/NotConfigured", () => ({ NotConfigured: () => null }));
vi.mock("@/components/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("@/components/g3/Section", () => ({ Note: () => null }));

const h = vi.hoisted(() => ({
  org: vi.fn(),
  channelCtx: vi.fn(),
}));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: h.org }));
vi.mock("@/lib/channels-server", () => ({ getChannelContext: h.channelCtx }));

import type { ReactElement } from "react";
function flatten(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => flatten(n, out));
  else if (node && typeof node === "object" && "props" in (node as object)) {
    out.push(node as ReactElement);
    flatten((node as ReactElement<{ children?: unknown }>).props.children, out);
  }
  return out;
}

beforeEach(() => {
  delete process.env.NIGHTSHIFT_RESULTS_DASHBOARD;
  h.org.mockReset().mockResolvedValue({ supported: true, orgs: [], current: { id: "o1" } });
  h.channelCtx.mockReset().mockResolvedValue({ slug: "alpha", selection: "chanA1" });
});
afterEach(() => vi.unstubAllEnvs());

describe("results page", () => {
  it("is a 404 while the switch is off and reads nothing", async () => {
    const { default: Page } = await import("../app/(app)/[channel]/analytics/results/page");
    await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(h.org).not.toHaveBeenCalled();
    expect(h.channelCtx).not.toHaveBeenCalled();
  });

  it("opens the dashboard on the channel of the URL, with links under the same channel", async () => {
    vi.stubEnv("NIGHTSHIFT_RESULTS_DASHBOARD", "on");
    const { default: Page } = await import("../app/(app)/[channel]/analytics/results/page");
    const tree = flatten(await Page());
    const dash = tree.find((e) => (e.props as { initialChannel?: string }).initialChannel !== undefined)!;
    expect(dash.props).toMatchObject({ initialChannel: "chanA1", videosHref: "/alpha/videos", channelsHref: "/alpha/channels" });
  });

  it("opens on all channels when the URL is the every-channel one", async () => {
    vi.stubEnv("NIGHTSHIFT_RESULTS_DASHBOARD", "on");
    h.channelCtx.mockResolvedValue({ slug: "all-channels", selection: "__all__" });
    const { default: Page } = await import("../app/(app)/[channel]/analytics/results/page");
    const dash = flatten(await Page()).find((e) => (e.props as { initialChannel?: string }).initialChannel !== undefined)!;
    expect((dash.props as { initialChannel: string }).initialChannel).toBe("all");
  });

  it("shows no dashboard to someone without an organization, or where organizations are not set up", async () => {
    vi.stubEnv("NIGHTSHIFT_RESULTS_DASHBOARD", "on");
    const { default: Page } = await import("../app/(app)/[channel]/analytics/results/page");
    for (const org of [{ supported: false, orgs: [], current: null }, { supported: true, orgs: [], current: null }]) {
      h.org.mockResolvedValue(org);
      const tree = flatten(await Page());
      expect(tree.find((e) => (e.props as { initialChannel?: string }).initialChannel !== undefined)).toBeUndefined();
    }
    expect(h.channelCtx).not.toHaveBeenCalled();
  });

  it("lives under the existing 'analytics' section, so it adds no top-level section and no navigation label", () => {
    expect(isSection("analytics")).toBe(true);
    expect(SECTIONS).not.toContain("results");
  });
});
