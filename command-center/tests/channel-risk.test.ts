/**
 * The pure half of the channel risk editors (lib/channelRisk.ts): what a person may type as a monthly spend limit, how a
 * stored value is read back, and that both agree with the worker (modules/channels.py) on the shared cases in
 * fixtures/channel-risk-cases.json, which tests/test_channel_risk_values.py reads too.
 *
 * What would break without these: a "0" or "1e5" saved by the page and read by the worker as NO limit; the page showing a
 * limit the worker does not enforce (or none while it does); a limit the page lets through that the worker drops.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_SPEND_CEILING_USD,
  ceilingChangeAllowed,
  effectiveSpendCeiling,
  formatUsd,
  flagIsOn,
  parseSpendCeiling,
  withSpendCeiling,
} from "@/lib/channelRisk";

const CASES = JSON.parse(readFileSync(join(__dirname, "fixtures/channel-risk-cases.json"), "utf8")) as {
  stored: { raw: unknown; worker: number | null }[];
  saveable: { typed: string; stored: number }[];
  refused: { typed: string; reason: string }[];
};

describe("parseSpendCeiling", () => {
  it.each(CASES.saveable)("stores $stored for the text '$typed'", ({ typed, stored }) => {
    expect(parseSpendCeiling(typed)).toEqual({ ok: true, value: stored });
  });

  it.each(CASES.refused)("refuses '$typed' as $reason", ({ typed, reason }) => {
    expect(parseSpendCeiling(typed)).toEqual({ ok: false, reason });
  });

  it("empty or blank means no limit, which is a deliberate answer and not an error", () => {
    expect(parseSpendCeiling("")).toEqual({ ok: true, value: null });
    expect(parseSpendCeiling("   ")).toEqual({ ok: true, value: null });
  });

  it("the largest amount is the one the page says it is", () => {
    expect(MAX_SPEND_CEILING_USD).toBe(1_000_000);
  });

  it("everything it accepts, the worker honours: it is the number back, never dropped to 'no limit'", () => {
    for (const c of CASES.saveable) {
      const r = parseSpendCeiling(c.typed);
      if (!r.ok || r.value === null) throw new Error("not saveable");
      const worker = CASES.stored.find((s) => s.raw === r.value)?.worker ?? r.value;
      expect(worker).toBe(r.value);
    }
  });
});

describe("effectiveSpendCeiling reads a stored value the way the worker does", () => {
  it.each(CASES.stored.map((c) => [JSON.stringify(c.raw), c.raw, c.worker] as const))("%s", (_label, raw, worker) => {
    expect(effectiveSpendCeiling(raw)).toBe(worker);
  });

  it("NaN, which JSON cannot carry but a script value can, is no limit", () => {
    expect(effectiveSpendCeiling(Number.NaN)).toBeNull();
    expect(effectiveSpendCeiling(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("withSpendCeiling merges one key into the live config", () => {
  it("sets the number and leaves every other key, including the controls, exactly as read", () => {
    const live = { storyboard_review: true, language: "Russian", publish_gate: { fact_check: true } };
    expect(withSpendCeiling(live, 25)).toEqual({ ...live, spend_ceiling_usd: 25 });
    expect(live).not.toHaveProperty("spend_ceiling_usd");
  });

  it("removes the key for no limit instead of storing null or 0", () => {
    const out = withSpendCeiling({ spend_ceiling_usd: 25, language: "Uzbek" }, null);
    expect(out).toEqual({ language: "Uzbek" });
    expect("spend_ceiling_usd" in out).toBe(false);
  });

  it("the pure merge reads a missing config as empty; the card itself refuses to write when the live read returned nothing", () => {
    expect(withSpendCeiling(null, 5)).toEqual({ spend_ceiling_usd: 5 });
  });
});

describe("flagIsOn: absent is on, only a real false is off (modules/channels.py)", () => {
  it.each([
    [undefined, true],
    [null, true],
    [true, true],
    [false, false],
    ["false", true],
    [0, true],
    ["", true],
  ])("%s -> %s", (raw, on) => {
    expect(flagIsOn(raw)).toBe(on);
  });
});

describe("ceilingChangeAllowed: an editor may set a first limit or lower one; raising or removing is an administrator's", () => {
  it.each([
    // live, next, canRaise, allowed
    [null, 25, false, true],
    [undefined, 25, false, true],
    ["abc", 25, false, true], // a stored value the worker ignores is no limit
    [0, 25, false, true],
    [40, 10, false, true],
    [40, 40, false, true],
    [40, 40.01, false, false],
    [40, 50, false, false],
    [40, null, false, false],
    ["40", null, false, false],
    [null, null, false, true], // nothing to remove
    ["abc", null, false, true],
    [40, 50, true, true],
    [40, null, true, true],
    [null, 25, true, true],
  ])("live %j -> %j, administrator %s: %s", (live, next, canRaise, allowed) => {
    expect(ceilingChangeAllowed(live, next as number | null, canRaise)).toBe(allowed);
  });
});

describe("formatUsd shows an amount the same way in every language", () => {
  it.each([
    [25, "$25.00"],
    [25.5, "$25.50"],
    [0.01, "$0.01"],
    [1_000_000, "$1,000,000.00"],
  ])("%s -> %s", (n, text) => {
    expect(formatUsd(n)).toBe(text);
  });
});

describe("typed text with an invisible mark in front", () => {
  it("a left-to-right / right-to-left mark or a BOM is ignored, not an 'invalid amount'", () => {
    expect(parseSpendCeiling("\u200f25")).toEqual({ ok: true, value: 25 });
    expect(parseSpendCeiling("\u202b2\u202c5")).toEqual({ ok: true, value: 25 });
    expect(parseSpendCeiling("\ufeff")).toEqual({ ok: true, value: null });
  });
});
