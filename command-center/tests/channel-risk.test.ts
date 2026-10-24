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
  effectiveSpendCeiling,
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

  it("an unreadable config is not turned into an empty one", () => {
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
