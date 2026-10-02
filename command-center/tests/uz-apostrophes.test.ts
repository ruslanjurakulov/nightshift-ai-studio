import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PIXEL-4 D7: Uzbek pages mixed the oʻ/gʻ letter (U+02BB) with an ASCII ' on
 * the same page. One spelling throughout: oʻ and gʻ with U+02BB, the tutuq
 * belgisi with U+02BC (maʼlumot, eʼlon), and a suffix after a Latin name with
 * U+2019 (YouTube’da) — never an ASCII apostrophe inside a word.
 */
const FILES = ["lib/i18n/uz.ts", "lib/i18n/site/uz.ts", "lib/legal-docs/uz.ts"];

describe("Uzbek text spells its apostrophes one way", () => {
  it.each(FILES)("%s has no ASCII apostrophe inside a word", (file) => {
    const text = readFileSync(join(__dirname, "..", file), "utf8");
    const hits = [...text.matchAll(/\S*[A-Za-zʻʼ]'[A-Za-z]\S*/g)].map((m) => m[0]).slice(0, 5);
    expect(hits).toEqual([]);
  });

  it.each(FILES)("%s writes oʻ / gʻ with U+02BB, not the tutuq or a quote mark", (file) => {
    const text = readFileSync(join(__dirname, "..", file), "utf8");
    // A turned comma after o/g is the letter; U+02BC or U+2019 there is a misspelling.
    const hits = [...text.matchAll(/\b\S*[oOgG][ʼ’](?=[a-z])\S*/g)]
      .map((m) => m[0])
      .filter((w) => !/^(?:YouTube|Google|Studio|ID)/.test(w))
      .slice(0, 5);
    expect(hits).toEqual([]);
  });
});
