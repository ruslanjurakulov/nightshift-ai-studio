/**
 * The region editor's strings exist in en, ru and uz with the same keys and the same {fillers}; every refusal code the
 * request can meet has a sentence in each language; none of the honest labels is left in English in ru / uz.
 * What would break without these: a Russian or Uzbek phone showing English or an empty line, a `{max}` printed
 * as the literal text, a refusal code with no sentence, a lost "AI-generated" label.
 */
import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { REGION_ERRORS } from "../lib/regionEdit/request";
import { regionEditorEnabled } from "../lib/regionEdit/flag";
import { REGION_REASONS, RUN_FAILURES } from "../lib/regionEdit/run";

const dicts = { en, ru, uz } as const;
const fillers = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function leaves(node: unknown, path = ""): [string, string][] {
  if (typeof node === "string") return [[path, node]];
  if (node && typeof node === "object") return Object.entries(node).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  return [];
}

describe("regionEdit parity", () => {
  const source = leaves(en.regionEdit);
  it("has strings (the check is not vacuous)", () => {
    expect(source.length).toBeGreaterThan(80);
  });

  it.each(["ru", "uz"] as const)("%s has exactly the keys of en, none empty, with the same {fillers}", (loc) => {
    const got = new Map(leaves(dicts[loc].regionEdit));
    expect([...got.keys()].sort()).toEqual(source.map(([k]) => k).sort());
    for (const [key, text] of source) {
      expect(got.get(key), `${loc}.${key}`).toBeTruthy();
      expect(fillers(got.get(key)!), `${loc}.${key} fillers`).toEqual(fillers(text));
    }
  });

  it.each(["en", "ru", "uz"] as const)("%s words every refusal code the request can answer", (loc) => {
    const errors = dicts[loc].regionEdit.errors as Record<string, string>;
    for (const code of REGION_ERRORS) expect(errors[code], `${loc}.errors.${code}`).toBeTruthy();
    expect(errors.failed).toBeTruthy();
  });

  it.each(["ru", "uz"] as const)("%s does not leave the honest labels in English", (loc) => {
    const r = dicts[loc].regionEdit as Record<string, unknown>;
    const e = en.regionEdit as Record<string, unknown>;
    for (const key of ["aiLabel", "lockBody", "runWhy", "previewNote", "modelNote"]) expect(r[key], `${loc}.${key}`).not.toBe(e[key]);
  });

  it("says the changed parts are AI-generated and claims nothing about quality", () => {
    expect(en.regionEdit.aiLabel).toMatch(/AI-generated/);
    expect(en.regionEdit.aiLabel).toMatch(/does not judge/);
    for (const [, text] of source) expect(text).not.toMatch(/\b(best|perfect|flawless|guarantee[sd]? quality|photorealistic)\b/i);
  });

  it("says what a run does with the money: the price is held and only applied regions are charged", () => {
    expect(en.regionEdit.previewNote).toMatch(/price is held/);
    expect(en.regionEdit.previewNote).toMatch(/only the regions that are applied are charged/);
    expect(en.regionEdit.quoteUnit).toMatch(/not charged/);
    expect(en.regionEdit.moneyHeld).toMatch(/never charged/);
    expect(en.regionEdit.runWhy).not.toMatch(/not connected/);
    for (const loc of ["ru", "uz"] as const) {
      expect(dicts[loc].regionEdit.previewNote, loc).not.toBe(en.regionEdit.previewNote);
      expect(dicts[loc].regionEdit.moneyNone, loc).not.toBe(en.regionEdit.moneyNone);
    }
  });

  it.each(["en", "ru", "uz"] as const)("%s words every reason a region can end without being applied, and every way a job can end without a picture", (loc) => {
    const r = dicts[loc].regionEdit as unknown as { reasons: Record<string, string>; failures: Record<string, string> };
    for (const code of REGION_REASONS) expect(r.reasons[code], `${loc}.reasons.${code}`).toBeTruthy();
    for (const code of [...RUN_FAILURES, "other"]) expect(r.failures[code], `${loc}.failures.${code}`).toBeTruthy();
    expect(Object.keys(r.reasons).sort()).toEqual([...REGION_REASONS].sort());
    expect(Object.keys(r.failures).sort()).toEqual([...RUN_FAILURES, "other"].sort());
  });

  it("shows no per-region price: the share the database charges is not re-derived in the page", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const text = dicts[loc].regionEdit.quotePerRegion;
      expect(text, loc).not.toMatch(/\{/);
      expect(text, loc).not.toMatch(/\d/);
    }
  });

  it("never tells a customer the state of the platform's vendor account (out of funds, a rejected key)", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const r = dicts[loc].regionEdit as unknown as { reasons: Record<string, string> };
      expect(r.reasons.quota, loc).toBe(r.reasons.unavailable);
      expect(r.reasons.auth, loc).toBe(r.reasons.unavailable);
      expect(r.reasons.not_configured, loc).toBe(r.reasons.unavailable);
    }
    for (const [, text] of source) expect(text).not.toMatch(/\b(api key|out of funds|balance ran out|quota)\b/i);
  });
});

describe("the switch", () => {
  it("is off unless explicitly on", () => {
    for (const v of [undefined, "", "off", "0", "false", "no", "enabled", " "]) expect(regionEditorEnabled(v)).toBe(false);
    for (const v of ["on", "ON", " 1 ", "true", "yes"]) expect(regionEditorEnabled(v)).toBe(true);
  });
});
