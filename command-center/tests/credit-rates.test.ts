import { describe, expect, it, vi } from "vitest";
import { chargedPrices, entryCredits, parsePrices } from "../lib/credits";
import { downloadCharge } from "../lib/downloads";
import { creditRates } from "../lib/pricing";

/**
 * BR-G-001 (migration 0084): the platform's margin is never a member's. The
 * Command Center prices every estimate, hold and customer screen from the
 * list AS CHARGED (credit_rates()), and reads the raw list — base rates,
 * margins, notes — only for the operator's editor and board.
 *
 * What would break without these: a member's page or estimate carrying the
 * margin again (the table read creeping back in), or the charged rate and the
 * old base × (1 + margin) arithmetic disagreeing, so a hold or a shown price
 * moves by a cent or by the whole margin.
 */

vi.mock("server-only", () => ({}));

const { readCreditPrices, readCreditPriceList } = await import("../lib/server/credits");

const RAW = [
  { unit: "video_minute", credits_per_unit: 12, margin: 0.5, note: "provider list $0.06/s" },
  { unit: "usd", credits_per_unit: 100, margin: 2.5, note: "master markup" },
  { unit: "job_minimum", credits_per_unit: 5, margin: 3, note: null },
  { unit: "download_minimum", credits_per_unit: 2, margin: 1, note: null },
  { unit: "download_1080p_minute", credits_per_unit: 1.25, margin: 2, note: null },
];
/** What credit_rates() returns for RAW (0084: floors flat, the rest x (1 + margin)). */
const CHARGED = [
  { unit: "download_1080p_minute", credits_per_unit: 3.75, updated_at: null },
  { unit: "download_minimum", credits_per_unit: 2, updated_at: null },
  { unit: "job_minimum", credits_per_unit: 5, updated_at: null },
  { unit: "usd", credits_per_unit: 350, updated_at: null },
  { unit: "video_minute", credits_per_unit: 18, updated_at: null },
];

type R = { data: unknown; error: { code?: string; message?: string } | null };

function db(rpcResult: R, tableResult: R = { data: RAW, error: null }) {
  const calls: string[] = [];
  const builder = (result: R): unknown => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "order", "eq"]) b[m] = () => b;
    b.then = (resolve: (v: R) => unknown) => resolve(result);
    return b;
  };
  return {
    calls,
    client: {
      rpc: (fn: string) => {
        calls.push(`rpc:${fn}`);
        return builder(rpcResult);
      },
      from: (t: string) => {
        calls.push(`from:${t}`);
        return builder(tableResult);
      },
    } as never,
  };
}

describe("readCreditPrices: the list as charged, never the margin", () => {
  it("reads credit_rates() and never the table", async () => {
    const d = db({ data: CHARGED, error: null });
    const read = await readCreditPrices(d.client);
    expect(d.calls).toEqual(["rpc:credit_rates"]);
    expect(read).toMatchObject({ supported: true, failed: false });
    expect(read.prices.usd).toMatchObject({ creditsPerUnit: 350, margin: 0, note: null });
  });

  it("before 0084 (function missing) reads the table and folds the margin in: same numbers, no margin, no note", async () => {
    const d = db({ data: null, error: { code: "PGRST202", message: "Could not find the function public.credit_rates" } });
    const read = await readCreditPrices(d.client);
    expect(d.calls).toEqual(["rpc:credit_rates", "from:credit_prices"]);
    expect(read.prices).toEqual(parsePrices(CHARGED));
    expect(JSON.stringify(read)).not.toMatch(/provider list|master markup/);
    for (const p of Object.values(read.prices)) expect(p.margin).toBe(0);
  });

  it("an errored read is unknown — never the table, never an empty (free) list", async () => {
    const d = db({ data: null, error: { code: "XX000", message: "boom" } });
    expect(await readCreditPrices(d.client)).toEqual({ supported: true, failed: true, prices: {} });
    expect(d.calls).toEqual(["rpc:credit_rates"]);
  });

  it("0020 missing altogether stays unsupported (the table is missing too)", async () => {
    const d = db({ data: null, error: { code: "42883", message: "function does not exist" } }, { data: null, error: { code: "42P01", message: "relation does not exist" } });
    expect(await readCreditPrices(d.client)).toMatchObject({ supported: false });
  });

  it("the operator's list is the raw table, margins and notes included", async () => {
    const d = db({ data: null, error: null });
    const read = await readCreditPriceList(d.client);
    expect(d.calls).toEqual(["from:credit_prices"]);
    expect(read.prices.usd).toMatchObject({ creditsPerUnit: 100, margin: 2.5, note: "master markup" });
  });
});

describe("chargedPrices: every charge is the same number as before 0084", () => {
  const raw = parsePrices(RAW);
  const charged = chargedPrices(raw);

  it("folds the margin into each rate; flat floors keep their own rate (margin ignored, 0020 / 0030)", () => {
    expect(charged).toEqual(parsePrices(CHARGED));
  });

  it("ledger entries, per-minute rates and downloads price identically from either list", () => {
    for (const e of [
      { unit: "usd", quantity: 0, usd: 0.37 },
      { unit: "tts_characters", quantity: 1200, usd: 1.13 },
      { unit: "video_minute", quantity: 3, usd: null },
    ]) {
      expect(entryCredits(e, charged)).toBeCloseTo(entryCredits(e, raw) as number, 9);
    }
    expect(creditRates(charged)).toEqual(creditRates(raw));
    for (const s of [1, 59, 61, 600, 3599]) expect(downloadCharge(s, "1080p", charged)).toBe(downloadCharge(s, "1080p", raw));
  });
});
