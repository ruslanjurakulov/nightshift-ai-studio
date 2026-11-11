/**
 * The Ads workspace's strings exist in en, ru and uz with the same keys and the same {fillers}; every closed-list word the database
 * can hold (objective, language, format, direction, kind, status) and every error word a route can answer has a sentence in each
 * language; ru and uz are marked as drafts that need a native read; and nothing claims what Phase 1 does not do.
 * What would break without these: a Russian or Uzbek screen showing English or an empty line, a `{max}` printed as the literal text,
 * an error word with no sentence, a page that promises generated ads or a scanned site, or copy that names another product or a model.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { AD_DIRECTIONS, AD_FORMAT_IDS, AD_KINDS, AD_LANGUAGES, AD_OBJECTIVES, AD_STATUSES, mapAdsError } from "../lib/adsFactory/model";
import { ADS_FACTORY_FLAG, adsFactoryEnabled } from "../lib/adsFactory/flag";
import { BANNED_PROVIDER_NAMES, bannedHits } from "../lib/marketing-banned";

const dicts = { en, ru, uz } as const;
const fillers = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function leaves(node: unknown, path = ""): [string, string][] {
  if (typeof node === "string") return [[path, node]];
  if (node && typeof node === "object") return Object.entries(node).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  return [];
}

describe("adsFactory parity", () => {
  const source = leaves(en.adsFactory);
  it("has strings (the check is not vacuous)", () => {
    expect(source.length).toBeGreaterThan(150);
  });

  it.each(["ru", "uz"] as const)("%s has exactly the keys of en, none empty, with the same {fillers}", (loc) => {
    const got = new Map(leaves(dicts[loc].adsFactory));
    expect([...got.keys()].sort()).toEqual(source.map(([k]) => k).sort());
    for (const [key, text] of source) {
      expect(got.get(key)?.trim(), `${loc}.${key}`).toBeTruthy();
      expect(fillers(got.get(key)!), `${loc}.${key} fillers`).toEqual(fillers(text));
    }
  });

  it.each(["ru", "uz"] as const)("%s is not left in English (beyond the format ratios and placeholders)", (loc) => {
    const got = new Map(leaves(dicts[loc].adsFactory));
    const same = source.filter(([k, v]) => got.get(k) === v).map(([k]) => k);
    expect(same.sort()).toEqual(["kits.sitePh"].sort());
  });

  it.each(["ru", "uz"] as const)("%s is marked as a draft that needs a native read", (loc) => {
    const file = readFileSync(join(__dirname, "..", "lib", "i18n", "ads-factory", `${loc}.ts`), "utf8");
    expect(file).toMatch(loc === "ru" ? /ЧЕРНОВИК ПЕРЕВОДА/ : /TARJIMA QORALAMASI/);
    expect(file).toContain("Strings that need a native read");
  });

  it.each(["en", "ru", "uz"] as const)("%s words every closed-list value the database can hold", (loc) => {
    const a = dicts[loc].adsFactory as unknown as Record<string, Record<string, string>>;
    for (const v of AD_OBJECTIVES) expect(a.objective[v], `${loc}.objective.${v}`).toBeTruthy();
    for (const v of AD_LANGUAGES) expect(a.language[v], `${loc}.language.${v}`).toBeTruthy();
    for (const v of AD_FORMAT_IDS) expect(a.format[v], `${loc}.format.${v}`).toBeTruthy();
    for (const v of AD_DIRECTIONS) expect(a.direction[v], `${loc}.direction.${v}`).toBeTruthy();
    for (const v of AD_KINDS) expect(a.kind[v], `${loc}.kind.${v}`).toBeTruthy();
    for (const v of AD_STATUSES) expect(a.status[v], `${loc}.status.${v}`).toBeTruthy();
    for (const f of AD_FORMAT_IDS) expect(a.format[f], `${loc}.format.${f}`).toContain(f);
  });

  it.each(["en", "ru", "uz"] as const)("%s has a sentence for every error word a route or the database can answer", (loc) => {
    const errors = dicts[loc].adsFactory.errors as Record<string, string>;
    const words = new Set<string>(["unauthorized", "forbidden", "not_found", "limit_reached", "org_required", "not_available", "failed"]);
    for (const message of ["kit_in_use", "concept_not_draft", "invalid_transition", "idempotency_conflict"]) words.add(mapAdsError({ code: "NS409", message }).error);
    const migration = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "0131_ads_factory.sql"), "utf8");
    for (const m of migration.matchAll(/raise exception '([a-z_]+)' using errcode = 'NS400'/g)) words.add(mapAdsError({ code: "NS400", message: m[1] }).error);
    words.delete("bad_request");
    expect(words.size).toBeGreaterThan(25);
    for (const w of words) expect(errors[w], `${loc}.errors.${w}`).toBeTruthy();
  });

  it("says what this version does NOT do, where a person could expect it", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const a = dicts[loc].adsFactory;
      for (const key of ["firstVersion", "siteHint", "templateNote", "approveNote", "briefHint", "approvedNothingStarted"] as const) {
        const text = key in a ? (a as unknown as Record<string, string>)[key] : (a.kits as Record<string, string>)[key] ?? (a.concepts as Record<string, string>)[key];
        expect(text, `${loc}.${key}`).toBeTruthy();
      }
    }
    expect(en.adsFactory.firstVersion).toMatch(/reads your site, makes a picture or a video, or spends credits/);
    expect(en.adsFactory.kits.siteHint).toMatch(/does not open or read the site/);
    expect(en.adsFactory.concepts.templateNote).toMatch(/fixed templates/);
    expect(en.adsFactory.concepts.templateNote).toMatch(/No model wrote them/);
    expect(en.adsFactory.concepts.approveNote).toMatch(/makes no picture or video and spends no credits/);
  });

  it.each(["en", "ru", "uz"] as const)("%s carries no banned claim and names no other product, vendor or model", (loc) => {
    const text = leaves(dicts[loc].adsFactory).map(([, v]) => v).join("\n");
    expect(bannedHits({ [loc]: text })).toEqual([]);
    for (const name of BANNED_PROVIDER_NAMES) expect(text.toLowerCase().includes(` ${name} `), name).toBe(false);
  });

  it("the navigation names the section in every language", () => {
    expect([en.nav.ads, ru.nav.ads, uz.nav.ads]).toEqual(["Ads", "Реклама", "Reklama"]);
  });
});

describe("the switch", () => {
  it("is named NIGHTSHIFT_ADS_FACTORY and is off unless explicitly on", () => {
    expect(ADS_FACTORY_FLAG).toBe("NIGHTSHIFT_ADS_FACTORY");
    for (const v of [undefined, "", "off", "0", "false", "no", "enabled", "onn"]) expect(adsFactoryEnabled(v), String(v)).toBe(false);
    for (const v of ["on", "1", "true", "yes", " ON ", "True"]) expect(adsFactoryEnabled(v), v).toBe(true);
  });
});
