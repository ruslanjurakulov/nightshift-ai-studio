import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLAN_ENV_VARS,
  coerceBillingSummary,
  coerceLots,
  coercePlanCatalog,
  columnPrice,
  planMatrix,
  planPrice,
  plansOnSale,
  sortLots,
  subscribeAccess,
  type PlanCatalog,
} from "@/lib/plans";
import { pricingTeaser } from "@/lib/landing";
import { portalOverviewUrl, resolvePaddleServerKey } from "@/lib/paddle";
import { DEFAULT_ORG_ID } from "@/lib/orgs";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

// The plan matrix and billing views (migration 0034). What must hold: the
// catalog is the database's (no plan is special-cased here), only ENFORCED
// entitlements are advertised, a price is never invented, and nobody is
// offered a checkout that cannot open or a second subscription.

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRICE_CREATOR = "pri_01plancreator000000000000";
const PRICE_PRO = "pri_01planpro00000000000000000";
const PADDLE = { environment: "sandbox" as const, clientToken: "test_abcdefghijkl" };

const planRows = [
  { id: "pro", name: "Pro", sort_order: 20, monthly_credits: "6000.00", is_default: false, is_public: true },
  { id: "free", name: "Free", sort_order: 0, monthly_credits: 0, is_default: true, is_public: true },
  { id: "creator", name: "Creator", sort_order: 10, monthly_credits: 2000, is_default: false, is_public: true },
  { id: "hidden", name: "Hidden", sort_order: 99, monthly_credits: 1, is_default: false, is_public: false },
  { id: "Bad Id", name: "x", sort_order: 1, monthly_credits: 1 },
];
const keyRows = [
  { key: "concurrency", value_type: "int", default_value: 1, exempt_value: 1000, status: "enforced", sort_order: 10 },
  { key: "api_access", value_type: "bool", default_value: false, exempt_value: true, status: "enforced", sort_order: 30 },
  { key: "mcp", value_type: "bool", default_value: false, exempt_value: true, status: "planned", sort_order: 56 },
  { key: "models_video", value_type: "tier", default_value: "basic", exempt_value: "all", status: "planned", sort_order: 41 },
  { key: "broken", value_type: "int", default_value: "x", exempt_value: 1, status: "enforced", sort_order: 1 },
];
const valueRows = [
  { plan_id: "creator", key: "concurrency", value: 2 },
  { plan_id: "creator", key: "api_access", value: true },
  { plan_id: "pro", key: "concurrency", value: 4 },
  { plan_id: "pro", key: "api_access", value: true },
  { plan_id: "pro", key: "mcp", value: true },
  { plan_id: "pro", key: "concurrency", value: "lots" }, // wrong type: ignored, 4 stays
  { plan_id: "ghost", key: "concurrency", value: 9 },
];

const catalog = coercePlanCatalog(planRows, keyRows, valueRows, [{ source: "pack", valid_months: 12 }]) as PlanCatalog;
const env = {
  NEXT_PUBLIC_PADDLE_PLAN_CREATOR: PRICE_CREATOR,
  NEXT_PUBLIC_PADDLE_PLAN_PRO: ` ${PRICE_PRO} `,
  NEXT_PUBLIC_PLAN_DISPLAY_CREATOR: "19 USD",
  NEXT_PUBLIC_PLAN_DISPLAY_PRO: "TBD",
};

describe("catalog", () => {
  it("keeps public, well-formed plans in sort order with defaults applied", () => {
    expect(catalog.plans.map((p) => p.id)).toEqual(["free", "creator", "pro"]);
    expect(catalog.plans[2].monthlyCredits).toBe(6000);
    expect(catalog.keys.map((k) => k.key)).toEqual(["concurrency", "api_access", "models_video", "mcp"]);
    expect(catalog.values.free).toEqual({ concurrency: 1, api_access: false, models_video: "basic", mcp: false });
    expect(catalog.values.pro.concurrency).toBe(4);
    expect(catalog.packValidMonths).toBe(12);
  });

  it("is null when the plans could not be read, so the page never shows an empty offer", () => {
    expect(coercePlanCatalog(null, [], [])).toBeNull();
    expect(coercePlanCatalog([], [], [], [{ source: "pack", valid_months: null }])?.packValidMonths).toBeNull();
  });
});

describe("plan prices from env", () => {
  it("reads price ids strictly and display prices with the /pricing rules", () => {
    expect(planPrice(env, "creator")).toEqual({ priceId: PRICE_CREATOR, displayPrice: "19 USD" });
    expect(planPrice(env, "pro")).toEqual({ priceId: PRICE_PRO, displayPrice: null }); // "TBD" is not a price
    expect(planPrice(env, "studio")).toEqual({ priceId: null, displayPrice: null });
    expect(planPrice({ NEXT_PUBLIC_PADDLE_PLAN_CREATOR: "price_123" }, "creator").priceId).toBeNull();
    expect(planPrice(env, "business")).toEqual({ priceId: null, displayPrice: null }); // a plan with no env yet
  });

  it("every env var the code names is plumbed through the deploy files", () => {
    const root = join(__dirname, "..", "..");
    const files = ["command-center/Dockerfile", "deploy/docker-compose.yml", "deploy/.env.web.example", ".github/workflows/deploy_web.yml"].map(
      (f) => readFileSync(join(root, f), "utf8"),
    );
    for (const v of Object.values(PLAN_ENV_VARS).flatMap((x) => [x.price, x.display]))
      for (const f of files) expect(f).toContain(v);
  });
});

describe("the matrix", () => {
  const m = planMatrix(catalog, env, PADDLE)!;

  it("lists every public plan and ONLY enforced entitlements", () => {
    expect(m.columns.map((c) => [c.id, c.priceId, c.displayPrice])).toEqual([
      ["free", null, null],
      ["creator", PRICE_CREATOR, "19 USD"],
      ["pro", PRICE_PRO, null],
    ]);
    expect(m.rows.map((r) => r.key)).toEqual(["concurrency", "api_access"]);
    expect(m.rows[0].cells).toEqual([1, 2, 4]);
    expect(m.purchasable).toBe(true);
    expect(plansOnSale(m)).toBe(true);
  });

  it("offers no checkout without Paddle, and nothing at all without a price", () => {
    const noPaddle = planMatrix(catalog, env, null)!;
    expect(noPaddle.columns.every((c) => c.priceId === null)).toBe(true);
    expect(noPaddle.purchasable).toBe(false);
    expect(plansOnSale(noPaddle)).toBe(true); // a display price is published
    expect(plansOnSale(planMatrix(catalog, {}, null))).toBe(false);
    expect(planMatrix(null, env, PADDLE)).toBeNull();
  });

  it("prices a column from Paddle first, then the owner's text, never a guess", () => {
    const [free, creator, pro] = m.columns;
    expect(columnPrice(free, null, false)).toEqual({ kind: "free" });
    expect(columnPrice(creator, { [PRICE_CREATOR]: "€17.99" }, false)).toEqual({ kind: "preview", text: "€17.99" });
    expect(columnPrice(creator, null, true)).toEqual({ kind: "display", text: "19 USD" });
    expect(columnPrice(pro, null, true)).toEqual({ kind: "pending" });
    expect(columnPrice(pro, {}, false)).toEqual({ kind: "at_checkout" });
    expect(columnPrice({ ...pro, priceId: null }, null, false)).toEqual({ kind: "unpublished" });
  });

  it("every enforced key and status has a label in every language", () => {
    for (const t of [en, ru, uz]) {
      for (const key of ["concurrency", "queue_priority", "api_access"]) expect((t.plans.row as Record<string, string>)[key]).toBeTruthy();
      for (const s of ["active", "trialing", "past_due", "paused", "canceled"] as const) expect(t.plans.status[s]).toBeTruthy();
    }
  });

  it("the enforced keys in the migration are the ones the UI can label", () => {
    const sql = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0034_plans_entitlements.sql"), "utf8");
    const enforced = [...sql.matchAll(/\('(\w+)',\s*'(?:int|bool|tier)',[^)]*'enforced'/g)].map((x) => x[1]);
    expect(enforced.length).toBeGreaterThan(0);
    for (const k of enforced) expect(Object.keys(en.plans.row)).toContain(k);
  });
});

describe("billing summary and access", () => {
  const live = coerceBillingSummary({
    exempt: false,
    plan: { id: "creator", name: "Creator", monthly_credits: 2000, is_default: false },
    subscription: { plan_id: "creator", status: "past_due", current_period_end: "2026-11-01T00:00:00Z", manageable: true },
    credits: { subscription: "1500.5", pack: 800, other: 100, held: 60 },
    next_expiry: { at: "2026-11-01T00:00:00Z", credits: 1500.5 },
    run_slots: { limit: 2, active: 1 },
  })!;
  const free = coerceBillingSummary({ exempt: false, plan: { id: "free", name: "Free", monthly_credits: 0, is_default: true }, subscription: null })!;
  const m = planMatrix(catalog, env, PADDLE);

  it("reads the database's summary", () => {
    expect(live.subscription).toEqual({
      planId: "creator",
      status: "past_due",
      periodEnd: "2026-11-01T00:00:00Z",
      cancelAtPeriodEnd: false,
      manageable: true,
      live: true,
    });
    expect(live.credits).toEqual({ subscription: 1500.5, pack: 800, other: 100, held: 60 });
    expect(live.runSlots).toEqual({ limit: 2, active: 1 });
    expect(coerceBillingSummary(null)).toBeNull();
    expect(coerceBillingSummary({ subscription: { plan_id: "x", status: "hacked" } })?.subscription).toBeNull();
  });

  it("an admin with a live subscription manages it — never a second checkout", () => {
    expect(subscribeAccess(ORG, "admin", m, live)).toBe("manage");
    expect(subscribeAccess(ORG, "editor", m, live)).toBe("hidden");
  });

  it("an admin on Free may subscribe; others are told who can; the operator never pays", () => {
    expect(subscribeAccess(ORG, "owner", m, free)).toBe("allowed");
    expect(subscribeAccess(ORG, "viewer", m, free)).toBe("admin_only");
    expect(subscribeAccess(DEFAULT_ORG_ID, "owner", m, free)).toBe("hidden");
    expect(subscribeAccess(ORG, "owner", planMatrix(catalog, env, null), free)).toBe("hidden");
  });
});

describe("lots", () => {
  const now = Date.parse("2026-10-15T00:00:00Z");
  const lots = coerceLots(
    [
      { id: 1, source: "adjustment", amount: 500, remaining: 400, held: 0, expires_at: null, created_at: "2026-01-01" },
      { id: 2, source: "pack", amount: 1000, remaining: 1000, held: 0, expires_at: "2027-09-01T00:00:00Z", created_at: "2026-09-01" },
      { id: 3, source: "subscription", amount: 2000, remaining: 1500, held: 100, expires_at: "2026-11-01T00:00:00Z", created_at: "2026-10-01" },
      { id: 4, source: "subscription", amount: 2000, remaining: 0, held: 0, expires_at: "2026-10-01T00:00:00Z", created_at: "2026-09-01" },
      { id: 5, source: "pack", amount: 1000, remaining: 10, held: 0, expires_at: "2026-12-01T00:00:00Z", created_at: "2025-12-01" },
      { id: 6, source: "bogus", amount: 1, remaining: 1 },
    ],
    now,
  );

  it("lists live lots in spend order, then history", () => {
    expect(sortLots(lots).map((l) => l.id)).toEqual([3, 5, 2, 1, 4]);
    expect(lots.find((l) => l.id === 4)?.expired).toBe(true);
  });
});

describe("landing teaser", () => {
  it("shows plans when they are on sale, packs otherwise", () => {
    const pricing = { source: "none" as const, packs: [], paddle: null };
    const t = pricingTeaser(pricing, planMatrix(catalog, env, PADDLE));
    expect(t).toEqual({
      kind: "plans",
      plans: [
        { id: "creator", name: "Creator", credits: 2000, price: "19 USD" },
        { id: "pro", name: "Pro", credits: 6000, price: null },
      ],
    });
    expect(pricingTeaser(pricing, planMatrix(catalog, {}, null))).toEqual({ kind: "announced" });
  });
});


describe("Manage subscription: the Paddle customer portal", () => {
  it("needs only the API key, in the environment it belongs to", () => {
    const key = "pdl_sdbx_apikey_0123456789abcdefghijklmnopqrstuv";
    expect(resolvePaddleServerKey({ PADDLE_API_KEY: key })).toEqual({ apiKey: key, baseUrl: "https://sandbox-api.paddle.com" });
    expect(resolvePaddleServerKey({ PADDLE_API_KEY: key, NEXT_PUBLIC_PADDLE_ENV: "production" })).toBeNull();
    expect(resolvePaddleServerKey({ PADDLE_API_KEY: "short" })).toBeNull();
    expect(resolvePaddleServerKey({})).toBeNull();
  });

  it("follows only an https link on paddle.com from the portal-session answer", () => {
    const ok = { data: { urls: { general: { overview: "https://customer-portal.paddle.com/cpl_01abc?action=overview&token=x" } } } };
    expect(portalOverviewUrl(ok)).toBe(ok.data.urls.general.overview);
    expect(portalOverviewUrl({ data: { urls: { general: { overview: "https://evil.example/paddle.com" } } } })).toBeNull();
    expect(portalOverviewUrl({ data: { urls: { general: { overview: "http://customer-portal.paddle.com/x" } } } })).toBeNull();
    expect(portalOverviewUrl({ data: { urls: { general: { overview: "https://paddle.com.evil.io/x" } } } })).toBeNull();
    expect(portalOverviewUrl(null)).toBeNull();
  });
});
