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
  SPEND_CEILING_LOCK_HINT,
  effectiveSpendCeiling,
  formatUsd,
  flagIsOn,
  isSpendCeilingLockRefusal,
  parseSpendCeiling,
} from "@/lib/channelRisk";

const CASES = JSON.parse(readFileSync(join(__dirname, "fixtures/channel-risk-cases.json"), "utf8")) as {
  stored: { raw: unknown; worker: number | null }[];
  saveable: { typed: string; stored: number }[];
  refused: { typed: string; reason: string }[];
  changes: { why: string; old?: unknown; new?: unknown; editor: "allowed" | "refused" }[];
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

describe("the spend-limit lock (migration 0119): what the page can know about it", () => {
  it("names the hint the database raises", () => {
    expect(SPEND_CEILING_LOCK_HINT).toBe("spend_ceiling_lock");
  });

  // The database decides who may move a limit from what to what, against the worker's reading of both values; the page's part is
  // to read the stored value as the worker does (the `stored` cases above) so that "in force" means the same on the screen. The
  // fixture's `changes` are asserted against the database in tests/security/test_sec_channel_settings.py and against the worker's
  // reader in tests/test_channel_risk_values.py; here they must be stated in terms of what the page shows.
  it.each(CASES.changes.map((c) => [c.why, c] as const))("the fixture's verdict agrees with what the page shows as in force: %s", (_why, c) => {
    const was = effectiveSpendCeiling(c.old);
    const now = effectiveSpendCeiling(c.new);
    const allowed = was === null || (now !== null && now <= was);
    expect(c.editor).toBe(allowed ? "allowed" : "refused");
  });

  it("is recognised by the hint or by the prefix of the message, not by any other refusal", () => {
    expect(isSpendCeilingLockRefusal({ hint: "spend_ceiling_lock", message: "" })).toBe(true);
    expect(isSpendCeilingLockRefusal({ message: "spend_ceiling_lock: only an administrator" })).toBe(true);
    expect(isSpendCeilingLockRefusal({ code: "42501", message: "only an administrator of this organization may change: auto_publish" })).toBe(false);
    expect(isSpendCeilingLockRefusal({ code: "42501", hint: "ai_disclosure_lock", message: "ai_disclosure_lock: x" })).toBe(false);
    expect(isSpendCeilingLockRefusal(null)).toBe(false);
    expect(isSpendCeilingLockRefusal(undefined)).toBe(false);
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
