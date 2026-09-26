import { describe, expect, it } from "vitest";
import {
  coerceAccount,
  coerceTransactions,
  creditRunError,
  entryCredits,
  estimateRunCredits,
  isCreditExempt,
  newCreditRef,
  parseGrantAmount,
  parseInsufficient,
  parsePriceInput,
  parsePrices,
  resolveCreditsEnforce,
  roundUpCredits,
  runDurationS,
  videoCredits,
  type PriceMap,
} from "../lib/credits";
import { buildRenderJobInsert } from "../lib/runBackend";
import { DEFAULT_ORG_ID } from "../lib/orgs";
import { en } from "../lib/i18n/en";

/**
 * Credits before a run: what Run now reserves, and how a refusal reads. What
 * must hold: an unset price is unpriced, never free; an estimate with no
 * honest basis is null and says why (it must never reserve a guess); the
 * operator's own organization is exempt; enforcement is off unless explicitly
 * on; and a queued job carries its hold only when one exists.
 */

const PRICES: PriceMap = parsePrices([
  { unit: "usd", credits_per_unit: 100, margin: 0.5 },
  { unit: "tts_characters", credits_per_unit: 0.001, margin: 0 },
]);

function video(drivers: { unit: string; quantity: number; usd: number | null }[], durationS: number | null = null) {
  return { drivers: drivers.map((d) => ({ ...d, key: d.unit, provider: null, videos: 1 })), durationS };
}

describe("pricing", () => {
  it("drops rows without a usable rate, so the unit stays unpriced", () => {
    const p = parsePrices([
      { unit: "usd", credits_per_unit: "100", margin: "0.2" },
      { unit: "render_seconds", credits_per_unit: null },
      { unit: "pexels_requests", credits_per_unit: -1 },
      { credits_per_unit: 3 },
      "junk",
    ]);
    expect(Object.keys(p)).toEqual(["usd"]);
    expect(p.usd.margin).toBe(0.2);
  });

  it("a unit's own price wins; usd prices only priced dollars; else null", () => {
    expect(entryCredits({ unit: "tts_characters", quantity: 2000, usd: 0.6 }, PRICES)).toBeCloseTo(2);
    expect(entryCredits({ unit: "render_seconds", quantity: 1, usd: 0.02 }, PRICES)).toBeCloseTo(3);
    expect(entryCredits({ unit: "render_seconds", quantity: 1, usd: null }, PRICES)).toBeNull();
  });

  it("a video with any unpriced driver has no credit cost, not its priced floor", () => {
    expect(videoCredits(video([{ unit: "tts_characters", quantity: 1000, usd: null }]), PRICES)).toBeCloseTo(1);
    expect(
      videoCredits(
        video([
          { unit: "tts_characters", quantity: 1000, usd: null },
          { unit: "upload_bytes", quantity: 1e9, usd: null },
        ]),
        PRICES,
      ),
    ).toBeNull();
  });

  it("rounds holds up to the cent", () => {
    expect(roundUpCredits(1.001)).toBe(1.01);
    expect(roundUpCredits(2.5)).toBe(2.5);
    expect(roundUpCredits(0.1 + 0.2)).toBe(0.3);
  });
});

describe("estimateRunCredits", () => {
  it("prices by the minute when a video_minute price and a length exist", () => {
    const prices = parsePrices([{ unit: "video_minute", credits_per_unit: 20, margin: 0.25 }]);
    const e = estimateRunCredits({ prices, durationS: 180, videos: [] });
    expect(e).toMatchObject({ credits: 75, basis: "per_minute", gap: null });
  });

  it("with a per-minute price but no length, says so rather than guessing", () => {
    const prices = parsePrices([{ unit: "video_minute", credits_per_unit: 20 }]);
    expect(estimateRunCredits({ prices, durationS: null, videos: [] })).toMatchObject({ credits: null, gap: "no_length" });
  });

  it("no prices at all is 'no_prices', never 0", () => {
    expect(estimateRunCredits({ prices: {}, durationS: 300, videos: [video([])] })).toMatchObject({
      credits: null,
      basis: "unknown",
      gap: "no_prices",
    });
  });

  it("history: p90 of fully priced videos, leaving partially priced ones out", () => {
    const videos = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) =>
      video([{ unit: "tts_characters", quantity: k * 1000, usd: null }]),
    );
    videos.push(video([{ unit: "upload_bytes", quantity: 1, usd: null }])); // unpriced — excluded
    const e = estimateRunCredits({ prices: PRICES, durationS: null, videos });
    expect(e.basis).toBe("history_video");
    expect(e.sample).toBe(10);
    expect(e.credits).toBeCloseTo(9.1);
  });

  it("history per minute when lengths are known", () => {
    const videos = [video([{ unit: "tts_characters", quantity: 6000, usd: null }], 120)]; // 3 credits / min
    const e = estimateRunCredits({ prices: PRICES, durationS: 600, videos });
    expect(e).toMatchObject({ credits: 30, basis: "history_minute", sample: 1 });
  });

  it("only unpriced history is a named gap", () => {
    const videos = [video([{ unit: "upload_bytes", quantity: 1, usd: null }])];
    expect(estimateRunCredits({ prices: PRICES, durationS: null, videos })).toMatchObject({
      credits: null,
      gap: "unpriced_history",
    });
    expect(estimateRunCredits({ prices: PRICES, durationS: null, videos: [] })).toMatchObject({ gap: "no_history" });
  });

  it("job_minimum is a floor under the estimate, and says it was applied", () => {
    const prices = parsePrices([
      { unit: "video_minute", credits_per_unit: 1 },
      { unit: "job_minimum", credits_per_unit: 10 },
    ]);
    expect(estimateRunCredits({ prices, durationS: 60, videos: [] })).toMatchObject({ credits: 10, floorApplied: true });
    expect(estimateRunCredits({ prices, durationS: 1200, videos: [] })).toMatchObject({ credits: 20, floorApplied: false });
  });
});

describe("switches and ids", () => {
  it("enforcement is off unless explicitly on", () => {
    expect(resolveCreditsEnforce({})).toBe(false);
    expect(resolveCreditsEnforce({ NIGHTSHIFT_CREDITS_ENFORCE: "enforce" })).toBe(false);
    expect(resolveCreditsEnforce({ NIGHTSHIFT_CREDITS_ENFORCE: " On " })).toBe(true);
  });

  it("only the default org is exempt", () => {
    expect(isCreditExempt(DEFAULT_ORG_ID)).toBe(true);
    expect(isCreditExempt("11111111-2222-3333-4444-555555555555")).toBe(false);
    expect(isCreditExempt(null)).toBe(false);
  });

  it("reservation refs match what the database and workflow accept", () => {
    const ref = newCreditRef("rj", "0a1b2c3d-4e5f-6789-abcd-ef0123456789");
    expect(ref).toMatch(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/);
    expect(newCreditRef("gh", "x; rm -rf ~")).toMatch(/^gh-[A-Za-z0-9-]*$/);
  });

  it("the run's length is the request's, else the channel's target", () => {
    expect(runDurationS(300, { target_duration_seconds: 600 })).toBe(300);
    expect(runDurationS(undefined, { target_duration_seconds: 600 })).toBe(600);
    expect(runDurationS(undefined, null)).toBeNull();
  });

  it("a queued job carries credit_ref only when a hold exists", () => {
    expect(buildRenderJobInsert("news", {}, "u")).not.toHaveProperty("credit_ref");
    expect(buildRenderJobInsert("news", {}, "u", null)).not.toHaveProperty("credit_ref");
    expect(buildRenderJobInsert("news", {}, "u", "rj-1")).toMatchObject({ credit_ref: "rj-1", params: {} });
  });
});

describe("reading rows and forms", () => {
  it("an org without an account row has zero credits; available never negative", () => {
    expect(coerceAccount(null)).toEqual({ balance: 0, reserved: 0, available: 0 });
    expect(coerceAccount({ balance: "100.50", reserved: "30" })).toEqual({ balance: 100.5, reserved: 30, available: 70.5 });
  });

  it("drops ledger rows with an unknown kind or no amount", () => {
    const rows = coerceTransactions([
      { id: 1, kind: "grant", amount: "100", balance_after: "100", reserved_after: "0", created_at: "t" },
      { id: 2, kind: "gift", amount: 5 },
      { id: 3, kind: "capture", amount: null },
    ]);
    expect(rows.map((r) => r.id)).toEqual([1]);
    expect(rows[0].amount).toBe(100);
  });

  it("grant amounts must be positive", () => {
    expect(parseGrantAmount("12,345")).toBe(12.35);
    expect(parseGrantAmount("0")).toBeNull();
    expect(parseGrantAmount("-5")).toBeNull();
    expect(parseGrantAmount("abc")).toBeNull();
  });

  it("price input mirrors the table's checks", () => {
    expect(parsePriceInput(" Video_Minute ", "2", "0.3")).toEqual({ unit: "video_minute", credits_per_unit: 2, margin: 0.3 });
    expect(parsePriceInput("usd", "1", "")).toEqual({ unit: "usd", credits_per_unit: 1, margin: 0 });
    expect(parsePriceInput("bad unit", "1", "0")).toBeNull();
    expect(parsePriceInput("usd", "-1", "0")).toBeNull();
    expect(parsePriceInput("usd", "1", "11")).toBeNull();
  });
});

describe("Run now refusals", () => {
  it("reads NS402's available/needed", () => {
    expect(parseInsufficient({ code: "NS402", details: "available=12.50 needed=40.00" })).toEqual({
      available: 12.5,
      needed: 40,
    });
    expect(parseInsufficient({ code: "42501", details: "" })).toBeNull();
  });

  it("says how many credits are needed and available", () => {
    expect(creditRunError({ error: "insufficient_credits", needed: 40, available: 12.5 }, en)).toBe(
      "Not enough credits: this run needs 40, 12.5 available.",
    );
  });

  it("names the fix when the estimate is impossible", () => {
    expect(creditRunError({ error: "credit_estimate_unavailable", gap: "no_prices" }, en)).toContain(
      en.credits.gap.no_prices,
    );
  });

  it("a failure after the hold was taken says the hold comes back by itself", () => {
    const msg = creditRunError({ error: "github_dispatch_failed", credits_held: 40 }, en);
    expect(msg).toBe(`${en.agents.runFailed} ${en.credits.heldNote}`);
  });

  it("leaves unrelated errors to the caller", () => {
    expect(creditRunError({ error: "github_unauthorized" }, en)).toBeNull();
  });
});
