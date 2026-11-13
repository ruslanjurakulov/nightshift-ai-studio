/**
 * The owner's per-provider ledger (Billing page) in en, ru and uz, and the line each source of use renders.
 *
 * What would break without these: an owner reading an English-only or empty line on a phone; a `{date}` shown as literal text;
 * a source that could not be read rendered as "$0" or as nothing; an estimate that does not say it is one; a unit the
 * dictionary does not know swallowed instead of shown.
 */
import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import type { SourceUse } from "../lib/billing";

const { sourceText } = await import("../components/billing/BillingBoard");

const dicts = { en, ru, uz } as const;
const fillers = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
function leaves(node: unknown, path = ""): [string, string][] {
  if (typeof node === "string") return [[path, node]];
  if (node && typeof node === "object") return Object.entries(node).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  return [];
}

describe("billingLedger parity", () => {
  const source = leaves(en.billingLedger);
  it.each(["ru", "uz"] as const)("%s has exactly the keys of en, none empty, with the same {fillers}", (loc) => {
    const got = new Map(leaves(dicts[loc].billingLedger));
    expect([...got.keys()].sort()).toEqual(source.map(([k]) => k).sort());
    for (const [key, text] of source) {
      expect(got.get(key), `${loc}.${key}`).toBeTruthy();
      expect(fillers(got.get(key)!), `${loc}.${key} fillers`).toEqual(fillers(text));
    }
  });
  it.each(["ru", "uz"] as const)("%s says why a balance is unknown in its own words", (loc) => {
    for (const why of Object.keys(en.billingLedger.leftUnknown) as (keyof typeof en.billingLedger.leftUnknown)[]) {
      expect(dicts[loc].billingLedger.leftUnknown[why]).not.toBe(en.billingLedger.leftUnknown[why]);
    }
  });
});

describe("sourceText", () => {
  const src = (over: Partial<SourceUse>): SourceUse => ({
    state: "ok",
    rows: 1,
    usd: null,
    pricedUsd: 0,
    estimate: false,
    unpriced: [],
    billingUnknown: 0,
    ...over,
  });
  const tl = en.billingLedger;

  it("names every state without a number: could not read, not recorded, not used, none", () => {
    expect(sourceText(src({ state: "unread", rows: 0 }), null, tl, "en")).toBe(tl.state.unread);
    expect(sourceText(src({ state: "untracked", rows: 0 }), null, tl, "en")).toBe(tl.state.untracked);
    expect(sourceText(src({ state: "not_used", rows: 0, usd: 0 }), null, tl, "en")).toBe(tl.state.notUsed);
    expect(sourceText(src({ rows: 0, usd: 0 }), null, tl, "en")).toBe(tl.state.none);
  });
  it("a measured figure in dollars and the vendor's credits; an estimate says so", () => {
    expect(sourceText(src({ rows: 2, usd: 0.85, pricedUsd: 0.85 }), 0.01, tl, "en")).toBe("$0.850 · 85 credits");
    expect(sourceText(src({ rows: 2, usd: 0.85, pricedUsd: 0.85, estimate: true }), 0.01, tl, "en")).toBe("$0.850 · 85 credits · estimate");
  });
  it("what has no price is shown as a quantity with 'USD unknown', and the priced part is a floor", () => {
    const text = sourceText(src({ rows: 3, pricedUsd: 0.42, unpriced: [{ unit: "second", quantity: 5, rows: 1 }] }), null, tl, "en");
    expect(text).toBe("at least $0.420 · 5 s, USD unknown");
    expect(sourceText(src({ unpriced: [{ unit: "weird_unit", quantity: null, rows: 2 }] }), null, tl, "en")).toBe("weird_unit: 2 rows, USD unknown");
  });
  it("probes that may have billed and a history read in part are both said", () => {
    expect(sourceText(src({ rows: 1, billingUnknown: 1 }), null, tl, "en")).toBe(tl.billingUnknown.replace("{n}", "1"));
    expect(sourceText(src({ state: "partial", rows: 1, pricedUsd: 2 }), null, tl, "en")).toBe(`at least $2.00 · ${tl.state.partial}`);
  });
  it("renders in Russian and Uzbek with their own words", () => {
    expect(sourceText(src({ state: "unread", rows: 0 }), null, ru.billingLedger, "ru")).toBe(ru.billingLedger.state.unread);
    expect(sourceText(src({ unpriced: [{ unit: "second", quantity: 5, rows: 1 }] }), null, uz.billingLedger, "uz")).toContain("USD narxi nomaʼlum");
  });
});
