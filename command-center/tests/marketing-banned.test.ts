/**
 * The banned-wording check on the New post form (lib/marketing-banned.ts).
 *
 * What would break without these: the page's copy of the list drifting from docs/news/banned-claims.json (a claim the worker would
 * refuse passing the owner's eye, or the reverse), a JavaScript regular expression that behaves differently from the Python one the
 * worker runs (a Cyrillic word boundary is the classic), a rule with no sentence to say in some language, and a warning that blocks.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { BANNED_PROVIDER_NAMES, BANNED_RULES, bannedHits } from "../lib/marketing-banned";

const ROOT = join(__dirname, "..", "..");
const json = JSON.parse(readFileSync(join(ROOT, "docs", "news", "banned-claims.json"), "utf8")) as {
  rules: { id: string; patterns: string[] }[];
  provider_names: { names: string[] };
};
const cases = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "marketing_banned_cases.json"), "utf8")).cases as { text: string; hits: string[] }[];
const dicts = { en, ru, uz } as const;

describe("the copy of the list is the list", () => {
  it("has the same rules, in the same order, with the same patterns, as docs/news/banned-claims.json", () => {
    expect(BANNED_RULES.map((r) => ({ id: r.id, patterns: [...r.patterns] }))).toEqual(json.rules.map((r) => ({ id: r.id, patterns: r.patterns })));
  });

  it("has the same provider names as the file", () => {
    expect([...BANNED_PROVIDER_NAMES]).toEqual(json.provider_names.names);
  });
});

describe("it says what the Python checker says", () => {
  it("has cases to compare", () => {
    expect(cases.length).toBeGreaterThanOrEqual(50);
  });

  it.each(cases.map((c, i) => [i, c] as const))("case %i", (_i, c) => {
    const got = bannedHits({ en: c.text }).map((h) => h.id).sort();
    expect(got, JSON.stringify(c.text)).toEqual(c.hits);
  });

  it("finds the same words in any of the three languages and says which one", () => {
    const hits = bannedHits({ uz: "Tinch matn.", ru: "Попробуйте бесплатно", en: "Unlimited videos" });
    expect(hits.map((h) => h.id).sort()).toEqual(["free", "unlimited"]);
    expect(hits.find((h) => h.id === "free")!.found).toEqual([{ lang: "ru", text: "бесплатно" }]);
    expect(hits.find((h) => h.id === "unlimited")!.found).toEqual([{ lang: "en", text: "unlimited" }]);
  });

  it("a clean post has no hit, and empty or missing texts are not an error", () => {
    expect(bannedHits({ uz: "Yangi funksiya.", ru: "Новая функция.", en: "A new feature." })).toEqual([]);
    expect(bannedHits({})).toEqual([]);
    expect(bannedHits({ en: "" })).toEqual([]);
  });

  it("the Uzbek apostrophes are all one apostrophe, as in the worker", () => {
    for (const a of ["'", "ʻ", "ʼ", "‘", "’", "`", "´"]) {
      expect(bannedHits({ uz: `Eng zo${a}r xizmat` }).map((h) => h.id), a).toEqual(["superlative"]);
    }
  });
});

describe("every rule has a sentence in every language", () => {
  it.each(["en", "ru", "uz"] as const)("%s", (loc) => {
    const rules = dicts[loc].marketing.newPost.banned.rules as Record<string, string>;
    for (const r of json.rules) expect(rules[r.id], `${loc}.${r.id}`).toBeTruthy();
    expect(Object.keys(rules).sort()).toEqual(json.rules.map((r) => r.id).sort());
  });
});
