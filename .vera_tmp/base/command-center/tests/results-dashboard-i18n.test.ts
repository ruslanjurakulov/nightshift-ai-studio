/**
 * The results dashboard's strings exist in en, ru and uz with the same keys and the same {fillers}; every status, privacy,
 * platform and platform state the payload can carry has a sentence in each language; the honest labels are not left in English
 * in ru / uz; and nothing claims what the page does not know.
 * What would break without these: a Russian or Uzbek phone showing English or an empty line, a `{n}` printed as the literal text,
 * a status with no word, a "not collected" turned into a number-like word, a "public" claim, a quality claim.
 */
import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { PLATFORM_IDS } from "../lib/resultsDashboard/platforms";
import { resultsDashboardEnabled } from "../lib/resultsDashboard/flag";

const dicts = { en, ru, uz } as const;
const fillers = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function leaves(node: unknown, path = ""): [string, string][] {
  if (typeof node === "string") return [[path, node]];
  if (node && typeof node === "object") return Object.entries(node).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  return [];
}

describe("resultsDashboard parity", () => {
  const source = leaves(en.resultsDashboard);
  it("has strings (the check is not vacuous)", () => {
    expect(source.length).toBeGreaterThan(90);
  });

  it.each(["ru", "uz"] as const)("%s has exactly the keys of en, none empty, with the same {fillers}", (loc) => {
    const got = new Map(leaves(dicts[loc].resultsDashboard));
    expect([...got.keys()].sort()).toEqual(source.map(([k]) => k).sort());
    for (const [key, text] of source) {
      expect(got.get(key), `${loc}.${key}`).toBeTruthy();
      expect(fillers(got.get(key)!), `${loc}.${key} fillers`).toEqual(fillers(text));
    }
  });

  it.each(["en", "ru", "uz"] as const)("%s words every status, privacy, platform and platform state the payload carries", (loc) => {
    const r = dicts[loc].resultsDashboard as unknown as Record<string, Record<string, string>>;
    for (const k of ["uploaded", "queued", "uploading", "processing", "failed", "refused"]) expect(r.status[k], `${loc}.status.${k}`).toBeTruthy();
    for (const k of ["private", "unlisted", "public", "selfOnly", "notRecorded"]) expect(r.privacy[k], `${loc}.privacy.${k}`).toBeTruthy();
    for (const id of PLATFORM_IDS) expect(r.platform[id], `${loc}.platform.${id}`).toBeTruthy();
    for (const k of ["live", "connected_results_coming", "not_connected", "coming", "unknown"]) expect(r.platformState[k], `${loc}.platformState.${k}`).toBeTruthy();
    for (const k of ["d7", "d28", "d90"]) expect(r.range[k], `${loc}.range.${k}`).toBeTruthy();
  });

  it.each(["ru", "uz"] as const)("%s does not leave the honest labels in English", (loc) => {
    const r = dicts[loc].resultsDashboard as Record<string, unknown>;
    const e = en.resultsDashboard as Record<string, unknown>;
    for (const key of ["subtitle", "firstVersion", "readingNote", "source", "notMeasured", "notCollected", "subscribersNote", "staleBody", "noReadingsBody", "historyNote", "platformsNote"]) {
      expect(r[key], `${loc}.${key}`).not.toBe(e[key]);
    }
  });

  it("says a reading is not a lifetime total, that subscribers are not collected, and that the page calls no platform", () => {
    expect(en.resultsDashboard.readingNote).toMatch(/not a lifetime total/);
    expect(en.resultsDashboard.readingNote).toMatch(/never added up/);
    expect(en.resultsDashboard.subscribersNote).toMatch(/does not store subscriber changes/);
    expect(en.resultsDashboard.source).toMatch(/does not call YouTube/);
    expect(en.resultsDashboard.subtitle).toMatch(/never publishes, never spends credits and never calls a platform/);
  });

  it("claims no quality, no growth and no 'public' outside the one word that names a recorded privacy", () => {
    for (const [key, text] of source) {
      if (key === "privacy.public") continue;
      expect(text, key).not.toMatch(/\b(best|perfect|viral|grow(?:th|ing)?|boost|guarantee[sd]?|live on)\b/i);
      expect(text, key).not.toMatch(/\bpublic(ly)?\b/i);
    }
  });

  it("an unknown is never worded as a zero", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const r = dicts[loc].resultsDashboard;
      for (const text of [r.notMeasured, r.notCollected, r.videoNotMeasured, r.noReadingYet]) expect(text, loc).not.toMatch(/^\s*0\s*$/);
    }
  });
});

describe("the switch", () => {
  it("is off unless explicitly on", () => {
    for (const v of [undefined, "", "off", "0", "false", "no", "enabled", " "]) expect(resultsDashboardEnabled(v)).toBe(false);
    for (const v of ["on", "ON", " 1 ", "true", "yes"]) expect(resultsDashboardEnabled(v)).toBe(true);
  });
});
