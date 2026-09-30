/**
 * CLAUDE.md #5 on the pages: when a read FAILS the page says "unknown" or shows
 * the error state with Retry — never a 0, an empty list, "Not required" or
 * "healthy". When a read succeeds and is genuinely empty, the normal empty
 * state stays.
 *
 * Server pages are async functions; we await them and render the element tree
 * to static markup against a scripted Supabase stub.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { EMPTY, NO_ROW, emptySupabase, esc, failingSupabase, supabaseStub } from "./helpers/supabaseStub";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/x/command-center" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }), headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => state.client,
  getUser: async () => ({ id: "u1", email: "me@example.com" }),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
vi.mock("@/lib/channels-server", async () => {
  const { unscopedScope } = await import("../lib/channels");
  const scope = unscopedScope();
  return {
    getChannelScope: async () => scope,
    getChannelContext: async () => ({ selection: scope.selection, channels: [], scope }),
    getChannelSelection: async () => "chan1",
    fetchScopedVideoIds: async () => null,
    fetchTopicScores: async () => [],
  };
});
vi.mock("@/lib/channels-path-server", () => ({ getChannelPath: async () => (s: string) => `/x${s}` }));
vi.mock("@/lib/orgs-server", () => ({
  getOrgContext: async () => ({
    supported: true,
    orgs: [],
    current: { id: "org-1", name: "Org", is_default: false, role: "owner" },
  }),
}));
vi.mock("@/lib/auth/org-roles", () => ({
  resolveCurrentOrgRole: async () => "owner",
  isOperator: async () => false,
  isPlatformAdmin: async () => false,
}));
vi.mock("@/lib/server/run-backend", () => ({ isRunNowConfigured: false, runBackend: "none" }));

async function render(load: () => Promise<ReactElement>): Promise<string> {
  return renderToStaticMarkup(await load());
}
const has = (html: string, text: string) => html.includes(esc(text));
/** A figure rendered as the digit 0 — the exact failure this PR removes. */
const zeroFigure = /(tabular-nums|t-figure)[^>]*>0</;

beforeEach(() => {
  state.client = failingSupabase();
});

describe("command center: a failed read is unknown, not zeros and not healthy", () => {
  const load = async () => (await import("../app/(app)/[channel]/command-center/page")).default();

  it("failed backend", async () => {
    const html = await render(load);
    expect(has(html, en.dashboard.unreadable)).toBe(true);
    expect(has(html, en.common.unknown)).toBe(true);
    expect(has(html, en.dashboard.heroUnknown)).toBe(true);
    // not healthy / active, no fake "nothing produced" / "none" / "no videos yet"
    expect(has(html, en.dashboard.systemHealthy)).toBe(false);
    expect(has(html, en.dashboard.active)).toBe(false);
    expect(has(html, en.dashboard.heroIdle)).toBe(false);
    expect(has(html, en.dashboard.noVideos)).toBe(false);
    expect(has(html, en.dashboard.noRunsYet)).toBe(false);
    expect(html).not.toMatch(zeroFigure);
    // one unknown per KPI (published today, active agents, errors 24h, videos)
    expect(html.split(esc(en.common.unknown)).length - 1).toBeGreaterThanOrEqual(4);
    expect(html).toContain("data-read-error");
  });

  it("readable but empty: real zeros, and NOT 'system healthy'", async () => {
    state.client = emptySupabase();
    const html = await render(load);
    expect(has(html, en.dashboard.noActivity)).toBe(true);
    expect(has(html, en.dashboard.systemHealthy)).toBe(false);
    expect(has(html, en.dashboard.unreadable)).toBe(false);
    expect(has(html, en.dashboard.noVideos)).toBe(true); // the genuine empty state stays
    expect(html).not.toContain("data-read-error");
  });
});

describe("credits: never a 0 balance on failure", () => {
  const load = async () => (await import("../app/(app)/[channel]/credits/page")).default();

  it("failed reads", async () => {
    const html = await render(load);
    expect(has(html, en.credits.readFailed)).toBe(true);
    expect(html.split(esc(en.common.unknown)).length - 1).toBe(3); // available / on hold / balance
    expect(html).not.toMatch(zeroFigure);
    expect(has(html, en.credits.ledgerEmpty)).toBe(false);
    expect(has(html, en.credits.pricesEmpty)).toBe(false);
    expect(html).toContain("data-read-error");
  });

  it("no account row is a real 0 and keeps the empty ledger", async () => {
    state.client = supabaseStub((name) => (name === "credit_accounts" ? NO_ROW : name === "is_platform_admin" ? { data: false, error: null } : EMPTY));
    const html = await render(load);
    expect(has(html, en.credits.ledgerEmpty)).toBe(true);
    expect(has(html, en.credits.readFailed)).toBe(false);
    expect(html).not.toContain("data-read-error");
  });
});

describe("approvals: an unreadable requirement is unknown and the toggle is disabled", () => {
  const load = async () => (await import("../app/(app)/[channel]/approvals/page")).default();

  it("failed read", async () => {
    const html = await render(load);
    expect(has(html, en.approvals.requireUnknown)).toBe(true);
    expect(has(html, en.approvals.requireUnknownNote)).toBe(true);
    expect(has(html, en.approvals.requireOff)).toBe(false);
    expect(html).not.toContain('role="switch"');
    expect(html).toMatch(/data-requirement-toggle[^>]*\sdisabled=""/);
  });

  it("readable: the switch is offered, enabled, and reads 'Not required'", async () => {
    state.client = supabaseStub(() => ({ data: { agent_config: {} }, error: null }));
    const html = await render(load);
    expect(has(html, en.approvals.requireOff)).toBe(true);
    expect(html).toContain('role="switch"');
    expect(html).not.toMatch(/role="switch"[^>]*\sdisabled=""/);
    expect(has(html, en.approvals.requireUnknown)).toBe(false);
  });

  it("readable and required", async () => {
    state.client = supabaseStub(() => ({ data: { agent_config: { require_two_person_publish: true } }, error: null }));
    const html = await render(load);
    expect(has(html, en.approvals.requireOn)).toBe(true);
  });
});

describe("list pages: a failed read shows the error state, not the empty text", () => {
  const cases: [string, string, string[]][] = [
    ["audit", "../app/(app)/[channel]/audit/page", [en.audit.empty]],
    ["logs", "../app/(app)/[channel]/logs/page", [en.logs.empty]],
    ["time-machine", "../app/(app)/[channel]/time-machine/page", []],
    ["intelligence", "../app/(app)/[channel]/intelligence/page", []],
    ["intelligence-map", "../app/(app)/[channel]/intelligence-map/page", []],
    ["studio", "../app/(app)/[channel]/studio/page", [en.studio.autopilotNone]],
    ["series", "../app/(app)/[channel]/series/page", [en.series.empty]],
  ];
  for (const [name, path, emptyTexts] of cases) {
    it(`${name}: failed`, async () => {
      const html = await render(async () => (await import(/* @vite-ignore */ path)).default());
      expect(html).toContain("data-read-error");
      expect(has(html, en.common.retry)).toBe(true);
      for (const text of emptyTexts) expect(has(html, text)).toBe(false);
    });
  }

  it("audit, logs, studio: a genuinely empty result keeps the normal empty state", async () => {
    state.client = emptySupabase();
    const audit = await render(async () => (await import("../app/(app)/[channel]/audit/page")).default());
    expect(has(audit, en.audit.empty)).toBe(true);
    expect(audit).not.toContain("data-read-error");
    const logs = await render(async () => (await import("../app/(app)/[channel]/logs/page")).default());
    expect(has(logs, en.logs.empty)).toBe(true);
    expect(logs).not.toContain("data-read-error");
    const studio = await render(async () => (await import("../app/(app)/[channel]/studio/page")).default());
    expect(has(studio, en.studio.autopilotNone)).toBe(true);
    expect(studio).not.toContain("data-read-error");
    const series = await render(async () => (await import("../app/(app)/[channel]/series/page")).default());
    expect(has(series, en.series.empty)).toBe(true);
    expect(series).not.toContain("data-read-error");
  });
});

describe("videos: the KPIs are unknown when the library could not be read", () => {
  const load = async () => (await import("../app/(app)/[channel]/videos/page")).default();

  it("failed", async () => {
    const html = await render(load);
    expect(has(html, en.videos.readErr)).toBe(true);
    expect(html.split(esc(en.common.unknown)).length - 1).toBe(3); // shown, total views, published today
    expect(html).not.toMatch(zeroFigure);
    expect(has(html, en.videos.empty)).toBe(false);
    expect(html).toContain("data-read-error");
  });

  it("empty: real zeros and the normal empty text", async () => {
    state.client = emptySupabase();
    const html = await render(load);
    expect(has(html, en.videos.empty)).toBe(true);
    expect(html).toMatch(zeroFigure);
    expect(has(html, en.common.unknown)).toBe(false);
  });
});
