/**
 * The Usage page (app/(app)/[channel]/usage/page.tsx), rendered against a
 * scripted Supabase: the states a person can really be in, and the reads that
 * can fail. CLAUDE.md #5 on this page: a read that failed is "could not read",
 * never 0% and never an empty meter; a deployment without migration 0094 says
 * so and leaves the Credits page as it was.
 *
 * What would break: a figure drawn when the read failed, "Free" or a 0 shown
 * for an unread plan, an expired period shown as spent, a missing-function
 * deployment shown as an error, the operator's workspace shown a meter, or a
 * link to a section of the Credits page that is not there.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { FAILED, supabaseStub, esc, type StubResult } from "./helpers/supabaseStub";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ client: null as unknown, org: "org-1" }));

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
vi.mock("@/lib/i18n/public-context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/x/usage" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/x${p}` }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client, getUser: async () => ({ id: "u1" }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }), headers: async () => new Headers() }));
vi.mock("@/lib/orgs-server", () => ({
  getOrgContext: async () => ({
    supported: true,
    orgs: [],
    current: { id: state.org, name: "Org", is_default: false, role: "owner" },
  }),
}));

const NOW = Date.now();
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

const summary = (over: Record<string, unknown> = {}) => ({
  exempt: false,
  extra_enabled: true,
  plan: { id: "creator", name: "Creator", monthly_credits: 2000, is_default: false },
  subscription: { status: "active", current_period_start: day(-9), current_period_end: day(21), cancel_at_period_end: false },
  plan_credits: { granted: 2000, spent: 1240, held: 0, left: 760, period_start: day(-9), period_end: day(21) },
  last_plan_period_end: day(21),
  extra_credits: { available: 500, soonest_expiry: day(300) },
  bonus_credits: { available: 0, soonest_expiry: null },
  spendable_now: 1260,
  run_slots: { exempt: false, limit: 2, active: 1 },
  entitlements: { concurrency: 2, queue_priority: 1, api_access: true },
  ...over,
});

const billing = (over: Record<string, unknown> = {}) => ({
  exempt: false,
  plan: { id: "creator", name: "Creator", monthly_credits: 2000, is_default: false },
  subscription: { plan_id: "creator", status: "active", current_period_end: day(21), cancel_at_period_end: false, manageable: true },
  credits: { subscription: 760, pack: 500, other: 0, held: 0 },
  next_expiry: null,
  run_slots: { limit: 2, active: 1 },
  ...over,
});

const MISSING: StubResult = { data: null, error: { message: "Could not find the function public.usage_summary", code: "PGRST202" } };
const ok = (data: unknown): StubResult => ({ data, error: null });

function client(over: Record<string, StubResult> = {}) {
  return supabaseStub((name) => {
    if (over[name]) return over[name];
    if (name === "usage_summary") return ok(summary());
    if (name === "billing_summary") return ok(billing());
    if (name === "plans") return ok([{ id: "free", name: "Free", sort_order: 0, monthly_credits: 0, is_default: true, is_public: true }]);
    return ok([]);
  });
}

async function render(): Promise<string> {
  const page = (await import("../app/(app)/[channel]/usage/page")).default as () => Promise<ReactElement>;
  return renderToStaticMarkup(await page());
}
const has = (html: string, text: string) => html.includes(esc(text));

beforeEach(() => {
  state.client = client();
  state.org = "org-1";
});

describe("the Usage page", () => {
  it("a subscriber at 62%: the share, the figures, the renewal, the switch and the extra balance", async () => {
    const html = await render();
    expect(html).toContain("62%");
    expect(html).toContain("data-plan-used");
    expect(html).toContain("1,240");
    expect(html).toContain("2,000");
    expect(html).toContain("data-plan-when");
    expect(has(html, "in 21 days")).toBe(true);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(has(html, en.usage.extra.toggleLabel)).toBe(true);
    expect(html).toContain("data-extra-balance");
    expect(has(html, "2 of 2 running now")).toBe(false);
    expect(has(html, "1 of 2 running now")).toBe(true);
    // No weekly or per-session meter: the platform has none.
    expect(html.toLowerCase()).not.toContain("weekly");
    expect(html.toLowerCase()).not.toContain("session");
  });

  it("the switch off is said by the switch, and the waiting credits are kept apart", async () => {
    state.client = client({ usage_summary: ok(summary({ extra_enabled: false, spendable_now: 760 })) });
    const html = await render();
    expect(html).toContain('aria-checked="false"');
    expect(has(html, en.usage.extra.waitingOff)).toBe(true);
  });

  it("all plan credits used, extra on with a pack: new runs use the extras", async () => {
    state.client = client({
      usage_summary: ok(summary({ plan_credits: { granted: 2000, spent: 2000, held: 0, left: 0, period_start: day(-9), period_end: day(21) }, spendable_now: 500 })),
    });
    const html = await render();
    expect(html).toContain("100%");
    expect(html).toContain("data-plan-ran-out");
    expect(has(html, en.usage.plan.usedUpOn)).toBe(true);
  });

  it("all plan credits used and extra off: new runs are refused, and the way out is named", async () => {
    state.client = client({
      usage_summary: ok(summary({ extra_enabled: false, plan_credits: { granted: 2000, spent: 2000, held: 0, left: 0, period_start: day(-9), period_end: day(21) }, spendable_now: 0 })),
    });
    const html = await render();
    expect(has(html, en.usage.plan.usedUpOff)).toBe(true);
  });

  it("no extra credits at all: zero is a real balance and the page says what to do", async () => {
    state.client = client({ usage_summary: ok(summary({ extra_credits: { available: 0, soonest_expiry: null } })) });
    const html = await render();
    expect(has(html, en.usage.extra.none)).toBe(true);
  });

  it("Free: the free credits left, what Free does not include, and no plan meter", async () => {
    state.client = client({
      usage_summary: ok(
        summary({
          plan: { id: "free", name: "Free", monthly_credits: 0, is_default: true },
          subscription: null,
          plan_credits: null,
          last_plan_period_end: null,
          bonus_credits: { available: 100, soonest_expiry: null },
          spendable_now: 100,
          extra_credits: { available: 0, soonest_expiry: null },
        }),
      ),
    });
    const html = await render();
    expect(html).toContain("data-free-left");
    expect(has(html, en.usage.free.title)).toBe(true);
    expect(html).not.toContain("data-plan-used");
    expect(html).not.toContain('role="meter"');
  });

  it("a live plan with no credits yet says so — not 0%", async () => {
    state.client = client({ usage_summary: ok(summary({ plan_credits: null, last_plan_period_end: null })) });
    const html = await render();
    expect(has(html, en.usage.plan.none)).toBe(true);
    expect(html).not.toContain("data-plan-used");
  });

  it("an expired period says it expired — not 100%", async () => {
    state.client = client({ usage_summary: ok(summary({ plan_credits: null, last_plan_period_end: day(-2) })) });
    const html = await render();
    expect(html).not.toContain("data-plan-used");
    expect(has(html, en.usage.plan.ended.split("{date}")[0])).toBe(true);
  });

  it("migration 0094 not applied: a plain note, no error state", async () => {
    state.client = client({ usage_summary: MISSING });
    const html = await render();
    expect(has(html, en.usage.notMigrated)).toBe(true);
    expect(html).not.toContain("data-read-error");
    expect(html).not.toContain('role="switch"');
  });

  it("a failed read is an error with Retry: no meter, no percent, no switch", async () => {
    state.client = client({ usage_summary: FAILED });
    const html = await render();
    expect(html).toContain("data-read-error");
    expect(has(html, en.usage.readFailed)).toBe(true);
    expect(html).not.toMatch(/>[^<]*\d\s?%[^<]*</);
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain('role="switch"');
  });

  it("a malformed summary is a failed read, not zeros", async () => {
    state.client = client({ usage_summary: ok({ extra_enabled: true, spendable_now: "n/a" }) });
    const html = await render();
    expect(html).toContain("data-read-error");
    expect(html).not.toContain('role="switch"');
  });

  it("the operator's own workspace is never shown an allowance", async () => {
    state.org = "00000000-0000-0000-0000-000000000001";
    const html = await render();
    expect(has(html, en.credits.exemptTitle)).toBe(true);
    expect(html).not.toContain('role="switch"');
  });

  it("'Upgrade plan' is not offered when nothing can be bought here", async () => {
    // No payment prices in this environment: the price list offers nothing to follow.
    state.client = client({
      usage_summary: ok(summary({ extra_credits: { available: 0, soonest_expiry: null }, plan_credits: { granted: 2000, spent: 2000, held: 0, left: 0, period_start: day(-9), period_end: day(21) }, spendable_now: 0 })),
    });
    const html = await render();
    expect(has(html, en.usage.extra.upgrade)).toBe(false);
    expect(html).not.toContain('href="/x/credits#plans"');
  });
});

describe("the Usage page links, with a price list that can be bought", () => {
  const PLAN_ROWS = [
    { id: "free", name: "Free", sort_order: 0, monthly_credits: 0, is_default: true, is_public: true },
    { id: "creator", name: "Creator", sort_order: 1, monthly_credits: 2000, is_default: false, is_public: true },
    { id: "pro", name: "Pro", sort_order: 2, monthly_credits: 6000, is_default: false, is_public: true },
  ];
  const KEY_ROWS = [
    { key: "concurrency", value_type: "int", default_value: 1, exempt_value: 1000, status: "enforced", sort_order: 10 },
    { key: "api_access", value_type: "bool", default_value: false, exempt_value: true, status: "enforced", sort_order: 30 },
  ];
  const VALUE_ROWS = [
    { plan_id: "creator", key: "concurrency", value: 2 },
    { plan_id: "creator", key: "api_access", value: true },
    { plan_id: "pro", key: "concurrency", value: 4 },
    { plan_id: "pro", key: "api_access", value: true },
  ];

  async function renderWithPrices(over: Record<string, StubResult>): Promise<string> {
    vi.stubEnv("NEXT_PUBLIC_PADDLE_ENV", "sandbox");
    vi.stubEnv("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN", "test_abcdefghijkl");
    vi.stubEnv("NEXT_PUBLIC_PADDLE_PRICE_STARTER", "pri_01starteraaaaaaaaaaaa");
    vi.stubEnv("NEXT_PUBLIC_PADDLE_PRICE_CREATOR", "pri_01creatoraaaaaaaaaaaa");
    vi.stubEnv("NEXT_PUBLIC_PADDLE_PRICE_STUDIO", "pri_01studioaaaaaaaaaaaaa");
    vi.stubEnv("NEXT_PUBLIC_PADDLE_PLAN_CREATOR", "pri_01plancreatoraaaaaaaa");
    vi.stubEnv("NEXT_PUBLIC_PADDLE_PLAN_PRO", "pri_01planproaaaaaaaaaaaa");
    vi.stubEnv("NEXT_PUBLIC_PLAN_DISPLAY_PRO", "49 USD");
    vi.resetModules();
    state.client = supabaseStub((name) => {
      if (over[name]) return over[name];
      if (name === "plans") return ok(PLAN_ROWS);
      if (name === "entitlement_keys") return ok(KEY_ROWS);
      if (name === "plan_entitlements") return ok(VALUE_ROWS);
      if (name === "billing_summary") return ok(billing());
      if (name === "usage_summary") return ok(summary());
      return ok([]);
    });
    try {
      const page = (await import("../app/(app)/[channel]/usage/page")).default as () => Promise<ReactElement>;
      return renderToStaticMarkup(await page());
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  }

  const spent = { granted: 2000, spent: 2000, held: 0, left: 0, period_start: day(-9), period_end: day(21) };

  it("out of credits on a plan with a higher one on sale: Buy credits and Upgrade plan, to the Credits page's own sections", async () => {
    const html = await renderWithPrices({
      usage_summary: ok(summary({ extra_enabled: false, extra_credits: { available: 0, soonest_expiry: null }, plan_credits: spent, spendable_now: 0 })),
    });
    expect(html).toContain('href="/x/credits#plans"');
    expect(html).toContain('href="/x/credits#topups"');
    expect(has(html, en.usage.extra.upgrade)).toBe(true);
    expect(has(html, en.usage.extra.buy)).toBe(true);
  });

  it("with credits left there is no upgrade banner, only Buy credits", async () => {
    const html = await renderWithPrices({});
    expect(has(html, en.usage.extra.upgrade)).toBe(false);
    expect(html).toContain('href="/x/credits#topups"');
  });

  it("Free: the upgrade link and what Free lacks, from the price list", async () => {
    const html = await renderWithPrices({
      usage_summary: ok(
        summary({
          plan: { id: "free", name: "Free", monthly_credits: 0, is_default: true },
          subscription: null,
          plan_credits: null,
          last_plan_period_end: null,
          bonus_credits: { available: 100, soonest_expiry: null },
          spendable_now: 100,
          extra_credits: { available: 0, soonest_expiry: null },
        }),
      ),
      billing_summary: ok(billing({ plan: { id: "free", name: "Free", monthly_credits: 0, is_default: true }, subscription: null })),
    });
    expect(has(html, en.usage.free.upgrade)).toBe(true);
    expect(has(html, en.usage.free.gap.credits)).toBe(true);
    expect(has(html, "More runs at once (Free: 1, plans: up to 4)")).toBe(true);
    expect(has(html, en.usage.free.gap.api_access)).toBe(true);
    expect(has(html, en.usage.free.gap.queue_priority)).toBe(false); // not on this price list
  });
});
