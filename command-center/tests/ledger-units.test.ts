/**
 * lib/server/ledger-units.ts: which ledger units name a vendor. What would break: a new unit such as `openai_tokens` added to
 * LEDGER_UNITS but not to VENDOR_NAMED_LEDGER_UNITS, so the bundle check would not look for it and its words would stay in
 * the browser dictionary.
 */
import { describe, expect, it } from "vitest";
import { LEDGER_UNITS, VENDOR_NAMED_LEDGER_UNITS } from "@/lib/server/ledger-units";
import { ledgerUnitLabels } from "@/lib/server/ledger-unit-labels";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

/** First words that name what is measured, not who is paid. */
const GENERIC_FIRST = new Set(["tts", "render", "upload", "video", "image", "vision"]);

describe("vendor-named ledger units", () => {
  it("every unit is either listed as vendor-named or starts with a vendor-free word", () => {
    const vendor = new Set<string>(VENDOR_NAMED_LEDGER_UNITS);
    for (const u of LEDGER_UNITS) if (!vendor.has(u)) expect(GENERIC_FIRST.has(u.split("_")[0]), u).toBe(true);
  });

  it("their words are on the server in all three languages, and in no shared dictionary", () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      expect(Object.keys(ledgerUnitLabels(locale, "long")).sort()).toEqual([...VENDOR_NAMED_LEDGER_UNITS].sort());
      expect(Object.keys(ledgerUnitLabels(locale, "measure")).length).toBeGreaterThan(0);
    }
    for (const t of [en, ru, uz]) {
      const shipped = JSON.stringify(t);
      for (const u of VENDOR_NAMED_LEDGER_UNITS) expect(shipped, u).not.toContain(u);
    }
  });
});
