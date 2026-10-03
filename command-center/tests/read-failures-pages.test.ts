/**
 * CLAUDE.md #5 on the pages: when a read FAILS the page says "unknown" or shows
 * the error state with Retry — never a 0, an empty list, "Not required" or
 * "healthy". When a read succeeds and is genuinely empty, the normal empty
 * state stays.
 *
 * Server pages are async functions; we await them and render the element tree
 * to static markup against a scripted Supabase stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { EMPTY, FAILED, NO_ROW, emptySupabase, esc, failingSupabase, supabaseStub } from "./helpers/supabaseStub";

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
// Shared components on the public pages read the public slice the same way.
vi.mock("@/lib/i18n/public-context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
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
    expect(html.split(`>${esc(en.common.unknown)}<`).length - 1).toBe(3); // available / on hold / balance
    expect(html).not.toMatch(zeroFigure);
    expect(has(html, en.credits.ledgerEmpty)).toBe(false);
    expect(has(html, en.credits.pricesEmpty)).toBe(false);
    expect(html).toContain("data-read-error");
  });

  it("no account row is a real 0 and keeps the empty ledger", async () => {
    state.client = supabaseStub((name) =>
      name === "credit_accounts" || name === "billing_summary" // billing_summary answers null when there is nothing to show
        ? NO_ROW
        : name === "is_platform_admin"
          ? { data: false, error: null }
          : name === "my_friend_invite"
            ? { data: NO_INVITE, error: null }
            : EMPTY,
    );
    const html = await render(load);
    expect(has(html, en.credits.ledgerEmpty)).toBe(true);
    expect(has(html, en.credits.readFailed)).toBe(false);
    expect(html).not.toContain("data-read-error");
  });
});

// ── plans (0034): a failed read of the plan, the lots or the catalog is unknown ──

const FREE_SUMMARY = {
  exempt: false,
  plan: { id: "free", name: "Free", monthly_credits: 0, is_default: true },
  subscription: null,
  credits: { subscription: 0, pack: 0, other: 0, held: 0 },
  next_expiry: null,
  run_slots: null,
};
const CATALOG_ROWS: Record<string, unknown[]> = {
  plans: [
    { id: "free", name: "Free", sort_order: 0, monthly_credits: 0, is_default: true, is_public: true },
    { id: "pro", name: "Pro", sort_order: 2, monthly_credits: 4000, is_default: false, is_public: true },
  ],
  entitlement_keys: [],
  plan_entitlements: [],
  credit_lot_policies: [],
};
const MISSING = { data: null, error: { message: "relation does not exist", code: "42P01" } };
// Migration 0092 applied, switch off, no link yet: the Invite friends card's healthy read.
const NO_INVITE = {
  enabled: false, required: 5, reward: 100, link: null, joined: 0, paid: false, credits_paid: null, pending: false,
};
/** A healthy deployment, with `over` replacing individual tables / functions. */
function plansClient(over: Record<string, { data: unknown; error: unknown }> = {}) {
  return supabaseStub((name) => {
    if (over[name]) return over[name];
    if (name === "credit_accounts") return { data: { balance: 50, reserved: 0 }, error: null };
    if (name === "billing_summary") return { data: FREE_SUMMARY, error: null };
    if (name === "is_platform_admin") return { data: false, error: null };
    if (name === "my_friend_invite") return { data: NO_INVITE, error: null };
    if (name in CATALOG_ROWS) return { data: CATALOG_ROWS[name], error: null };
    return EMPTY;
  });
}

describe("credits plans: unknown, never 'Free', 0 or an empty list", () => {
  const load = async () => (await import("../app/(app)/[channel]/credits/page")).default();

  it("healthy: the plan, the empty lots text and the normal ledger", async () => {
    state.client = plansClient();
    const html = await render(load);
    expect(html).toContain(`Free`);
    expect(has(html, en.plans.lotsEmpty)).toBe(true);
    expect(html).not.toContain("data-read-error");
  });

  it("billing summary failed: plan unknown, nothing to choose, no 'Free'", async () => {
    state.client = plansClient({ billing_summary: FAILED });
    const html = await render(load);
    expect(has(html, en.plans.billingReadFailed)).toBe(true);
    expect(has(html, en.common.retry)).toBe(true);
    expect(html).not.toContain("Free");
    expect(has(html, en.plans.planCredits)).toBe(false);
    expect(has(html, en.plans.subscribe)).toBe(false);
  });

  it("billing summary with unreadable credit figures is a failed read, not 0 credits", async () => {
    state.client = plansClient({
      billing_summary: { data: { ...FREE_SUMMARY, credits: { subscription: "x", pack: null } }, error: null },
    });
    const html = await render(load);
    expect(has(html, en.plans.billingReadFailed)).toBe(true);
    expect(has(html, en.plans.planCredits)).toBe(false);
  });

  it("a summary with no plan shows the plan as unknown, not 'Free'", async () => {
    state.client = plansClient({ billing_summary: { data: { ...FREE_SUMMARY, plan: null }, error: null } });
    const html = await render(load);
    expect(html).not.toContain("Free");
    expect(has(html, en.common.unknown)).toBe(true);
  });

  it("lots failed: error state, not 'No credits yet'", async () => {
    state.client = plansClient({ credit_lots: FAILED });
    const html = await render(load);
    expect(has(html, en.plans.lotsReadFailed)).toBe(true);
    expect(has(html, en.plans.lotsEmpty)).toBe(false);
  });

  it("Invite friends: the card when migration 0092 is applied, nothing before it, an honest error when unread", async () => {
    state.client = plansClient();
    expect(has(await render(load), en.invite.title)).toBe(true);
    state.client = plansClient({ my_friend_invite: { data: null, error: { message: "Could not find the function", code: "PGRST202" } } });
    const before = await render(load);
    expect(has(before, en.invite.title)).toBe(false);
    expect(before).not.toContain("data-read-error");
    state.client = plansClient({ my_friend_invite: FAILED });
    const failed = await render(load);
    expect(has(failed, en.invite.readFailed)).toBe(true);
    expect(failed).not.toContain("data-invite-card");
  });
  it("a lot row that cannot be read fails the list instead of dropping it", async () => {
    state.client = plansClient({ credit_lots: { data: [{ id: 1, source: "pack", amount: "many", remaining: 5 }], error: null } });
    const html = await render(load);
    expect(has(html, en.plans.lotsReadFailed)).toBe(true);
  });

  it("catalog failed (plan known): the plan shows, the choice is unknown not absent", async () => {
    state.client = plansClient({ plans: FAILED });
    const html = await render(load);
    expect(html).toContain("Free");
    expect(has(html, en.plans.readFailed)).toBe(true);
    expect(has(html, en.plans.billingReadFailed)).toBe(false);
  });

  it("migration 0034 not applied: what the page showed before, no error state", async () => {
    state.client = plansClient({
      billing_summary: MISSING,
      credit_lots: MISSING,
      plans: MISSING,
      entitlement_keys: MISSING,
      plan_entitlements: MISSING,
    });
    const html = await render(load);
    expect(html).not.toContain("data-read-error");
    expect(has(html, en.plans.panelTitle)).toBe(false);
    expect(has(html, en.plans.lotsTitle)).toBe(false);
    expect(has(html, en.credits.available)).toBe(true);
  });

  describe("with a plan on sale", () => {
    beforeEach(() => {
      vi.stubEnv("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN", "test_abcdefghijkl");
      vi.stubEnv("NEXT_PUBLIC_PADDLE_ENV", "sandbox");
      vi.stubEnv("NEXT_PUBLIC_PADDLE_PLAN_PRO", "pri_abcdefghij12");
      vi.resetModules();
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("offers the plan when the summary reads (proves the next case is the read failure's doing)", async () => {
      state.client = plansClient();
      const html = await render(load);
      expect(has(html, en.plans.subscribe)).toBe(true);
    });

    it("offers no checkout when the summary failed: a live subscription may exist", async () => {
      state.client = plansClient({ billing_summary: FAILED });
      const html = await render(load);
      expect(has(html, en.plans.subscribe)).toBe(false);
      expect(has(html, en.plans.billingReadFailed)).toBe(true);
    });
  });
});

describe("pricing: a failed read is unknown, not 'none on sale' or 'not published'", () => {
  const load = async () => (await import("../app/pricing/page")).default();

  it("catalog and rates failed (signed in)", async () => {
    state.client = failingSupabase();
    const html = await render(load);
    expect(has(html, en.plans.readFailed)).toBe(true);
    expect(has(html, en.pricing.ratesReadFailed)).toBe(true);
    expect(has(html, en.pricing.ratesUnavailable)).toBe(false);
    expect(html).toContain("data-read-error");
  });

  it("catalog failed, signed out: the plans say they could not be read", async () => {
    state.client = supabaseStub((name) => (name in CATALOG_ROWS ? FAILED : EMPTY), null);
    const html = await render(load);
    expect(has(html, en.plans.readFailed)).toBe(true);
    expect(has(html, en.pricing.ratesSignedOut)).toBe(true);
  });

  it("not applied / healthy: no error state", async () => {
    state.client = supabaseStub((name) => (name in CATALOG_ROWS ? MISSING : name === "credit_prices" ? EMPTY : EMPTY));
    const html = await render(load);
    expect(has(html, en.plans.readFailed)).toBe(false);
    expect(has(html, en.pricing.ratesReadFailed)).toBe(false);
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
    expect(html.split(`>${esc(en.common.unknown)}<`).length - 1).toBe(3); // shown, total views, published today
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
