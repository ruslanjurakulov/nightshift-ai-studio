/**
 * The Credits page, phone-first (balance → plans → packs → history).
 *
 * Pure rules pinned first: what a plan's credits buy is computed from today's
 * prices the way 0036 quotes a generation (never typed, never invented when
 * nothing is priced); a yearly saving never overstates; the balance by source
 * leaves out what the account does not have instead of showing 0; and every
 * ledger row reads as a plain sentence. Then one light render of the whole
 * page against a scripted Supabase: the terms come before the buy buttons,
 * the equivalents carry the computed numbers, and no payment provider is
 * named to the customer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { EMPTY, esc, supabaseStub } from "./helpers/supabaseStub";
import {
  balanceSplit,
  creditEquivalents,
  generationRates,
  yearlySavingPercent,
  type BillingSummary,
  type CreditLot,
  type PricedModel,
} from "../lib/plans";
import { txnLabel, txnPurpose } from "../lib/account";
import { parsePrices } from "../lib/credits";
import { pluralForm } from "../components/credits/Equivalents";

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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => "/x/credits" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, getAll: () => [] }), headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => state.client,
  getUser: async () => ({ id: "u1", email: "me@example.com" }),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
vi.mock("@/lib/orgs-server", () => ({
  getOrgContext: async () => ({
    supported: true,
    orgs: [],
    current: { id: "org-1", name: "Org", is_default: false, role: "owner" },
  }),
}));

// ── pure rules ───────────────────────────────────────────────────────────────

const model = (over: Partial<PricedModel> & { spec?: Partial<PricedModel["spec"]> } = {}): PricedModel => ({
  capabilities: ["t2i"],
  entitlement: null,
  creditsPerUnit: 4,
  margin: 0.25,
  ...over,
  spec: { unit: "image", durationsS: [], ...over.spec },
});
const video = (perSecond: number, durations: number[], over: Partial<PricedModel> = {}) =>
  model({ capabilities: ["t2v"], creditsPerUnit: perSecond, margin: 0, spec: { unit: "second", durationsS: durations }, ...over });

describe("generationRates: priced like 0036's quote, from the registry only", () => {
  it("takes the cheapest image and the cheapest shortest clip", () => {
    const r = generationRates([model(), model({ creditsPerUnit: 10 }), video(2, [10, 5]), video(1, [8])], {});
    expect(r.image).toBe(5); // 1 × 4 × 1.25
    expect(r.shortVideo).toEqual({ credits: 8, seconds: 8 }); // 8 s × 1 beats 5 s × 2
    expect(r.videoMinute).toBeNull();
  });

  it("raises a price to the job minimum and rounds up to the cent, as the database does", () => {
    const prices = parsePrices([{ unit: "job_minimum", credits_per_unit: 6, margin: 0 }]);
    expect(generationRates([model()], prices).image).toBe(6);
    expect(generationRates([model({ creditsPerUnit: 0.333, margin: 0 })], {}).image).toBe(0.34);
  });

  it("ignores models behind an entitlement or a first purchase: the equivalent must hold for everyone", () => {
    const r = generationRates([model({ entitlement: "models_video:premium" }), model({ entitlement: "paid" })], {});
    expect(r.image).toBeNull();
    expect(generationRates([model({ entitlement: "any" })], {}).image).toBe(5);
  });

  it("a video model without a listed duration prices nothing (no guessed length)", () => {
    expect(generationRates([video(2, [])], {}).shortVideo).toBeNull();
  });

  it("no models, no prices: every rate unknown, never 0", () => {
    expect(generationRates(null, {})).toEqual({ image: null, shortVideo: null, videoMinute: null });
  });

  it("per-minute channel video from the video_minute price with its margin", () => {
    const prices = parsePrices([{ unit: "video_minute", credits_per_unit: 40, margin: 0.5 }]);
    expect(generationRates(null, prices).videoMinute).toBe(60);
  });
});

describe("creditEquivalents", () => {
  const rates = { image: 5, shortVideo: { credits: 10, seconds: 5 }, videoMinute: 60 };

  it("counts whole items, rounded down", () => {
    expect(creditEquivalents(4000, rates)).toEqual({ images: 800, videos: { count: 400, seconds: 5 }, minutes: 66 });
  });

  it("leaves out what is unpriced or would read 0", () => {
    expect(creditEquivalents(30, rates)).toEqual({ images: 6, videos: { count: 3, seconds: 5 }, minutes: null });
    expect(creditEquivalents(100, { image: null, shortVideo: null, videoMinute: 60 })).toEqual({ images: null, videos: null, minutes: 1 });
  });

  it("is null when nothing can be said", () => {
    expect(creditEquivalents(4000, null)).toBeNull();
    expect(creditEquivalents(4000, { image: null, shortVideo: null, videoMinute: null })).toBeNull();
    expect(creditEquivalents(0, rates)).toBeNull();
    expect(creditEquivalents(3, rates)).toBeNull();
  });
});

describe("yearlySavingPercent", () => {
  it("the saving over twelve months, never rounded up", () => {
    expect(yearlySavingPercent(10, 96)).toBe(20);
    expect(yearlySavingPercent(12, 119.99)).toBe(16); // 16.67% reads 16, not 17
    expect(yearlySavingPercent(5, 36)).toBe(40);
  });

  it("no saving, or no honest price: null (the page then shows no badge)", () => {
    expect(yearlySavingPercent(10, 120)).toBeNull();
    expect(yearlySavingPercent(10, 130)).toBeNull();
    expect(yearlySavingPercent(0, 100)).toBeNull();
    expect(yearlySavingPercent(10, 0)).toBeNull();
    expect(yearlySavingPercent(Number.NaN, 50)).toBeNull();
  });
});

const summary = (credits: BillingSummary["credits"], live = false): BillingSummary => ({
  exempt: false,
  plan: { id: live ? "pro" : "free", name: live ? "Pro" : "Free", monthlyCredits: live ? 4000 : 0, isDefault: !live },
  subscription: live
    ? { planId: "pro", status: "active", periodEnd: "2026-11-01T00:00:00Z", cancelAtPeriodEnd: false, manageable: true, live: true }
    : null,
  credits,
  nextExpiry: null,
  runSlots: null,
});
const lot = (over: Partial<CreditLot>): CreditLot => ({
  id: 1,
  source: "pack",
  amount: 100,
  remaining: 100,
  held: 0,
  expiresAt: null,
  expired: false,
  createdAt: "2026-01-01T00:00:00Z",
  note: null,
  ...over,
});

describe("balanceSplit: what exists, never a made-up 0", () => {
  const account = { balance: 55, reserved: 5, available: 50 };

  it("available / held / total from the account, sources from the summary, expiry from the lots", () => {
    const s = balanceSplit(account, summary({ subscription: 30, pack: 20, other: 0, held: 5 }, true), [
      lot({ id: 1, source: "subscription", remaining: 35, held: 5, expiresAt: "2026-11-01T00:00:00Z" }),
      lot({ id: 2, source: "pack", remaining: 15, expiresAt: "2027-06-01T00:00:00Z" }),
      lot({ id: 3, source: "pack", remaining: 5, expiresAt: "2027-03-01T00:00:00Z" }),
      lot({ id: 4, source: "pack", remaining: 9, expiresAt: "2026-01-01T00:00:00Z", expired: true }),
    ]);
    expect([s.available, s.held, s.total]).toEqual([50, 5, 55]);
    expect(s.sources).toEqual([
      { source: "plan", credits: 30, expiresAt: "2026-11-01T00:00:00Z" },
      { source: "pack", credits: 20, expiresAt: "2027-03-01T00:00:00Z" },
    ]);
  });

  it("a free account with nothing from a source lists no source rows", () => {
    expect(balanceSplit(account, summary({ subscription: 0, pack: 0, other: 0, held: 0 }), []).sources).toEqual([]);
  });

  it("a live plan keeps its row even when its credits are used up", () => {
    const s = balanceSplit(account, summary({ subscription: 0, pack: 0, other: 0, held: 0 }, true), []);
    expect(s.sources).toEqual([{ source: "plan", credits: 0, expiresAt: null }]);
  });

  it("account unread: figures unknown, held falls back to the summary's own count", () => {
    const s = balanceSplit(null, summary({ subscription: 0, pack: 3, other: 1, held: 7 }), null);
    expect([s.available, s.held, s.total]).toEqual([null, 7, null]);
    expect(s.sources?.map((x) => [x.source, x.credits, x.expiresAt])).toEqual([
      ["pack", 3, null],
      ["other", 1, null],
    ]);
  });

  it("nothing read: everything unknown and no source list at all", () => {
    expect(balanceSplit(null, null, null)).toEqual({ available: null, held: null, total: null, sources: null });
  });
});

describe("ledger rows in plain language", () => {
  it("names what a hold or a charge was for from its job reference", () => {
    expect(txnPurpose("cj:3f1c")).toBe("generation");
    expect(txnPurpose("rj-abc")).toBe("video");
    expect(txnPurpose("gh-abc")).toBe("video");
    expect(txnPurpose("download:9")).toBe("download");
    expect(txnPurpose("ah-1")).toBe("api");
    expect(txnPurpose(null)).toBe("other");
    expect(txnLabel({ kind: "reserve", jobId: "cj:1" })).toBe("reserve.generation");
    expect(txnLabel({ kind: "capture", jobId: "rj-1" })).toBe("capture.video");
  });

  it("a refund on a download is credits coming back; any other refund is a purchase refunded", () => {
    expect(txnLabel({ kind: "refund", jobId: "download:7" })).toBe("refundDownload");
    expect(txnLabel({ kind: "refund", jobId: null })).toBe("refund");
  });

  it("every label has a sentence in en, ru and uz", () => {
    const kinds = ["grant", "purchase", "reserve", "capture", "release", "refund", "adjust", "subscription", "expire"];
    const refs = [null, "cj:1", "rj-1", "download:1", "ah-1"];
    for (const dict of [en, ru, uz]) {
      for (const kind of kinds) {
        for (const jobId of refs) {
          const [head, purpose] = txnLabel({ kind, jobId }).split(".");
          const txn = dict.creditsPage.txn as unknown as Record<string, string | Record<string, string>>;
          const text = purpose ? (txn[head] as Record<string, string>)[purpose] : txn[head];
          expect(typeof text === "string" && text.length > 0, `${kind} ${jobId}`).toBe(true);
        }
      }
    }
  });
});

describe("plural forms", () => {
  it("Russian picks one / few / many", () => {
    const f = ru.creditsPage.eq.images;
    expect(pluralForm(f, 1, "ru")).toBe(f.one);
    expect(pluralForm(f, 3, "ru")).toBe(f.few);
    expect(pluralForm(f, 800, "ru")).toBe(f.many);
    expect(pluralForm(en.creditsPage.eq.images, 1, "en")).toBe(en.creditsPage.eq.images.one);
    expect(pluralForm(en.creditsPage.eq.images, 2, "en")).toBe(en.creditsPage.eq.images.other);
  });
});

// ── the page ─────────────────────────────────────────────────────────────────

const LIVE_SUMMARY = {
  exempt: false,
  plan: { id: "free", name: "Free", monthly_credits: 0, is_default: true },
  subscription: null,
  credits: { subscription: 0, pack: 20, other: 0, held: 5 },
  next_expiry: null,
  run_slots: null,
};
const MODELS = [
  {
    id: "img-a",
    display_name: "Image A",
    provider: "vendor",
    capabilities: ["t2i"],
    availability: "ga",
    verified_at: "2026-09-01T00:00:00Z",
    credit_unit: "img_a",
    entitlement: null,
    credits_per_unit: 4,
    margin: 0.25,
    spec: { output: "image", unit: "image", limits: { max_prompt_chars: 2000, max_concurrent_per_org: 2 } },
  },
  {
    id: "vid-a",
    display_name: "Video A",
    provider: "vendor",
    capabilities: ["t2v"],
    availability: "ga",
    verified_at: "2026-09-01T00:00:00Z",
    credit_unit: "vid_a",
    entitlement: null,
    credits_per_unit: 2,
    margin: 0,
    spec: { output: "video", unit: "second", durations_s: [5, 10], limits: { max_prompt_chars: 2000, max_concurrent_per_org: 1 } },
  },
];
const TABLES: Record<string, unknown> = {
  credit_accounts: { balance: 75, reserved: 5 },
  billing_summary: LIVE_SUMMARY,
  is_platform_admin: false,
  sellable_models: MODELS,
  plans: [
    { id: "free", name: "Free", sort_order: 0, monthly_credits: 0, is_default: true, is_public: true },
    { id: "pro", name: "Pro", sort_order: 2, monthly_credits: 4000, is_default: false, is_public: true },
  ],
  entitlement_keys: [],
  plan_entitlements: [],
  credit_lot_policies: [{ source: "pack", valid_months: 12 }],
  credit_lots: [
    { id: 2, source: "pack", amount: 1000, remaining: 25, held: 5, expires_at: "2027-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z" },
  ],
  credit_transactions: [
    { id: 3, kind: "capture", amount: -5, balance_after: 75, reserved_after: 5, job_id: "cj:1", note: null, created_at: "2026-09-30T10:00:00Z" },
    { id: 2, kind: "reserve", amount: 5, balance_after: 80, reserved_after: 10, job_id: "rj-1", note: null, created_at: "2026-09-30T09:00:00Z" },
    { id: 1, kind: "purchase", amount: 1000, balance_after: 1000, reserved_after: 0, job_id: null, note: "Paddle txn_1: 1× starter", created_at: "2026-09-01T00:00:00Z" },
  ],
};
const client = () => supabaseStub((name) => (name in TABLES ? { data: TABLES[name], error: null } : EMPTY));

describe("credits page: clear, honest, terms before buying", () => {
  const load = async () => (await import("../app/(app)/[channel]/credits/page")).default() as Promise<ReactElement>;
  const has = (html: string, text: string) => html.includes(esc(text));

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN", "test_abcdefghijkl");
    vi.stubEnv("NEXT_PUBLIC_PADDLE_ENV", "sandbox");
    vi.stubEnv("NEXT_PUBLIC_PADDLE_PLAN_PRO", "pri_abcdefghij12");
    vi.stubEnv("NEXT_PUBLIC_PADDLE_PRICE_STARTER", "pri_starter00001");
    vi.resetModules();
    state.client = client();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("balance, plans with computed equivalents, packs, plain history; terms above every buy button", async () => {
    const html = renderToStaticMarkup(await load());
    // balance: available = 75 − 5, held, and only the source that has credits
    expect(html).toMatch(/data-balance-available[^>]*>70</);
    expect(html).toContain(`>${esc(en.creditsPage.source.pack)}<`);
    expect(html).not.toContain(`>${esc(en.creditsPage.source.plan)}<`);
    expect(has(html, en.creditsPage.heldHint)).toBe(true);
    // Pro: 4000 credits = 800 images at 5, 400 clips of 5 s at 10 — computed, not typed
    expect(html).toContain("≈ 800 images");
    expect(html).toContain("≈ 400 videos of 5 s");
    // the starter pack: 1000 credits = 200 images
    expect(html).toContain("≈ 200 images");
    // terms (with the 12-month pack validity from the database) before the buttons
    const planTerms = html.indexOf(esc(en.creditsPage.planTerms));
    const subscribe = html.indexOf(`>${esc(en.plans.subscribe)}<`);
    expect(planTerms).toBeGreaterThan(-1);
    expect(subscribe).toBeGreaterThan(planTerms);
    const packTerms = html.indexOf(esc(en.creditsPage.packTermsMonths.replace("{months}", "12")));
    const buyButton = html.indexOf(`>${esc(en.creditsPage.buy)}<`);
    expect(packTerms).toBeGreaterThan(-1);
    expect(buyButton).toBeGreaterThan(packTerms);
    expect(html.split('href="/terms#credits"').length - 1).toBe(2);
    // history in plain language
    expect(has(html, en.creditsPage.txn.capture.generation)).toBe(true);
    expect(has(html, en.creditsPage.txn.reserve.video)).toBe(true);
    expect(has(html, en.creditsPage.txn.purchase)).toBe(true);
    // no payment provider named, no raw ledger note, no operator switch for a customer
    expect(html).not.toMatch(/paddle/i);
    expect(has(html, en.credits.enforcedOff)).toBe(false);
    expect(has(html, en.credits.pricesTitle)).toBe(false);
  });

  it("models unreadable: no equivalents at all rather than invented ones", async () => {
    state.client = supabaseStub((name) =>
      name === "sellable_models"
        ? { data: null, error: { message: "boom", code: "XX000" } }
        : name in TABLES
          ? { data: TABLES[name], error: null }
          : EMPTY,
    );
    const html = renderToStaticMarkup(await load());
    expect(html).not.toContain("data-equivalents");
    expect(html).not.toContain("≈");
    expect(has(html, en.plans.subscribe)).toBe(true);
  });
});
