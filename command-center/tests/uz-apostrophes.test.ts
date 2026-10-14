import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PIXEL-4 D7: Uzbek pages mixed the oʻ/gʻ letter (U+02BB) with an ASCII ' on
 * the same page. One spelling throughout: oʻ and gʻ with U+02BB, the tutuq
 * belgisi with U+02BC (maʼlumot, eʼlon), and a suffix after a Latin name with
 * U+2019 (YouTube’da) — never an ASCII apostrophe inside a word.
 */
// Every feature dictionary (lib/i18n/<feature>/uz.ts) is found by listing the folder, so a new one is checked without editing this list.
const FEATURES = readdirSync(join(__dirname, "..", "lib/i18n"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => `lib/i18n/${e.name}/uz.ts`)
  .filter((f) => existsSync(join(__dirname, "..", f)));
const FILES = ["lib/i18n/uz.ts", ...FEATURES, "lib/i18n/site/dev-uz.ts", "lib/legal-docs/uz.ts"];

describe("Uzbek text spells its apostrophes one way", () => {
  it.each(FILES)("%s has no ASCII apostrophe after a letter, inside a word or at its end", (file) => {
    const text = readFileSync(join(__dirname, "..", file), "utf8");
    // Word-final too: "obroʻ" was written "obro'" and the inside-a-word check missed it (PIXEL-5 N4).
    // These files quote with double quotes, so a ' after a letter is always text.
    const hits = [...text.matchAll(/\S*[A-Za-zʻʼ]'\S*/g)].map((m) => m[0]).slice(0, 5);
    expect(hits).toEqual([]);
  });

  it.each(FILES)("%s has no U+2018 (left single quote) where the letter ʻ (U+02BB) belongs", (file) => {
    const text = readFileSync(join(__dirname, "..", file), "utf8");
    // soʻrayotganini was typed so‘rayotganini: it looks the same, but it is another character and breaks search and sorting.
    const hits = [...text.matchAll(/\S*\u2018\S*/g)].map((m) => m[0]).slice(0, 5);
    expect(hits).toEqual([]);
  });

  it("lists the feature dictionaries it checks", () => {
    expect(FEATURES).toEqual(expect.arrayContaining(["lib/i18n/editor-export/uz.ts", "lib/i18n/library-ux/uz.ts", "lib/i18n/overlay/uz.ts", "lib/i18n/presets/uz.ts", "lib/i18n/studio-page/uz.ts", "lib/i18n/site/uz.ts"]));
  });

  it.each(FILES)("%s writes oʻ / gʻ with U+02BB, not the tutuq or a quote mark", (file) => {
    const text = readFileSync(join(__dirname, "..", file), "utf8");
    // A turned comma after o/g is the letter; U+02BC or U+2019 there is a misspelling.
    const hits = [...text.matchAll(/\b\S*[oOgG][ʼ’\u2018](?=[a-z])\S*/g)]
      .map((m) => m[0])
      .filter((w) => !/^(?:YouTube|Google|Studio|ID)/.test(w))
      .slice(0, 5);
    expect(hits).toEqual([]);
  });
});
