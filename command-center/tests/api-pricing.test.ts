import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_TIERS,
  DEFAULT_API_PRICES,
  apiEligible,
  downloadPriceCents,
  parseLimitDollars,
  parseTopupDollars,
  tierFor,
  videoPriceCents,
} from "@/lib/api/pricing";
import { DEFAULT_ORG_ID } from "@/lib/orgs";

const SQL = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0031_public_api.sql"), "utf8");
const SQL_0030 = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0030_paid_downloads.sql"), "utf8");
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("usage tiers", () => {
  it("rise with cumulative paid top-ups", () => {
    expect(tierFor(0).tier).toBe(0);
    expect(tierFor(499).tier).toBe(0);
    expect(tierFor(500).tier).toBe(1);
    expect(tierFor(4_999).tier).toBe(1);
    expect(tierFor(5_000).tier).toBe(2);
    expect(tierFor(25_000).tier).toBe(3);
    expect(tierFor(100_000).tier).toBe(4);
    expect(tierFor(0, true).tier).toBe(4);
  });

  it("match the SQL twin in 0031 (api_tier_for / api_tier_limits)", () => {
    const thresholds = [...SQL.matchAll(/when p_paid_cents >= (\d+) then (\d)/g)].map((m) => [Number(m[2]), Number(m[1])]);
    for (const [tier, min] of thresholds) expect(API_TIERS[tier].minPaidCents).toBe(min);
    const arrays = [...SQL.matchAll(/\(array\[([\d, ]+)\](?:::bigint\[\])?\)\[p_tier \+ 1\]/g)].map((m) => m[1].split(",").map(Number));
    expect(arrays).toEqual([
      API_TIERS.map((t) => t.rpm),
      API_TIERS.map((t) => t.concurrency),
      API_TIERS.map((t) => t.monthlyCapCents),
    ]);
  });

  it("are what the owner priced: 30/2/$100 … 300/10/$10,000", () => {
    expect(API_TIERS.slice(1).map((t) => [t.minPaidCents, t.rpm, t.concurrency, t.monthlyCapCents])).toEqual([
      [500, 30, 2, 10_000],
      [5_000, 60, 3, 50_000],
      [25_000, 120, 5, 200_000],
      [100_000, 300, 10, 1_000_000],
    ]);
  });
});

describe("prices", () => {
  const p = { ...DEFAULT_API_PRICES };

  it("charge $1.20 a requested minute, at least $0.60, rounded up to the cent", () => {
    expect(videoPriceCents(60, p)).toBe(120);
    expect(videoPriceCents(90, p)).toBe(180);
    expect(videoPriceCents(20, p)).toBe(60);
    expect(videoPriceCents(61, p)).toBe(122);
    expect(videoPriceCents(3600, p)).toBe(7200);
  });

  it("are unpriced, never free, without a per-minute price", () => {
    expect(videoPriceCents(60, { job_minimum: 60 })).toBeNull();
    expect(videoPriceCents(null, p)).toBeNull();
  });

  it("seed the same defaults in SQL", () => {
    expect(SQL).toContain("('video_minute', 120,");
    expect(SQL).toContain("('job_minimum', 60,");
    expect(SQL).toContain("('publish', 0,");
    expect(SQL).toContain("('download_cents_per_credit', 1.5,");
  });

  it("price an HD download at the site's credits x $0.01 x 1.5", () => {
    // 0030's examples: the 3:15 video is 10 credits in 720p, 17 in 1080p.
    expect(downloadPriceCents(10, p)).toBe(15);
    expect(downloadPriceCents(17, p)).toBe(26);
  });

  it("reuse 0030's credit formula for a download, character for character", () => {
    const formula = "greatest(ceil(round(m.duration_seconds * rate.credits_per_unit * (1 + rate.margin) / 60.0, 6)),";
    expect(SQL_0030).toContain(formula);
    expect(SQL).toContain(formula.replace("m.duration_seconds", "p_seconds"));
  });
});

describe("activation eligibility (mirrors api_org_eligible)", () => {
  const purchase = (note: string, amount = 1000) => ({ kind: "purchase", amount, note, created_at: "2026-09-01T00:00:00Z" });

  it("opens to an organization that bought any pack — Starter included", () => {
    expect(apiEligible(ORG, [purchase("Paddle txn_1: 1× starter")])).toBe(true);
    expect(apiEligible(ORG, [purchase("Paddle txn_2: 1× studio", 20000)])).toBe(true);
    expect(apiEligible(ORG, [purchase("custom amount", 1234)])).toBe(true);
  });

  it("stays closed with only grants (the welcome credits) or nothing", () => {
    expect(apiEligible(ORG, [{ kind: "grant", amount: 100, note: "welcome" }])).toBe(false);
    expect(apiEligible(ORG, [])).toBe(false);
    expect(apiEligible(ORG, null)).toBe(false);
  });

  it("is always open to the operator's own organization", () => {
    expect(apiEligible(DEFAULT_ORG_ID, [])).toBe(true);
    expect(SQL).toMatch(/public\.credits_exempt\(p_org\)\s+or exists \(select 1 from public\.credit_transactions t where t\.org_id = p_org and t\.kind = 'purchase'\)/);
  });
});

describe("amounts typed in the console", () => {
  it("top-ups are $5–$5,000 in whole cents", () => {
    expect(parseTopupDollars("5")).toBe(500);
    expect(parseTopupDollars("$25.50")).toBe(2550);
    expect(parseTopupDollars("25,5")).toBe(2550);
    expect(parseTopupDollars("4.99")).toBeNull();
    expect(parseTopupDollars("5000.01")).toBeNull();
    expect(parseTopupDollars("1e3")).toBeNull();
  });

  it("limits are optional dollars", () => {
    expect(parseLimitDollars("")).toEqual({ ok: true, cents: null });
    expect(parseLimitDollars("100")).toEqual({ ok: true, cents: 10000 });
    expect(parseLimitDollars("-1")).toEqual({ ok: false });
  });
});
