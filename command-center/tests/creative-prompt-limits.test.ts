import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { CREATIVE_ERRORS, mapCreativeError } from "@/lib/creative/operations";

// Migration 0218's three refusals, as the Studio's routes answer them. What would break: a word the database raises read as the
// generic "Some settings are not valid" (the person is not told which fix: shorten, remove the negative prompt, remove the seed), or a
// language that shows the code instead of a sentence.

const ROOT = join(__dirname, "..", "..");
const SQL = readFileSync(join(ROOT, "supabase/migrations/0218_creative_prompt_limits.sql"), "utf8");
const WORDS = ["prompt_too_long", "negative_prompt_not_supported", "seed_not_supported"] as const;

describe("0218's refusals", () => {
  it("are the words the migration raises, each with NS400", () => {
    for (const w of WORDS) expect(SQL).toContain(`creative_refuse('${w}',`);
  });

  it.each(WORDS)("%s is answered 400 with its own code and the database's detail", (w) => {
    const r = mapCreativeError({ code: "NS400", message: w, details: "1 characters over this model's limit of 300; shorten the prompt" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(w);
    expect(r.body.detail).toBe("1 characters over this model's limit of 300; shorten the prompt");
    expect(CREATIVE_ERRORS).toContain(w);
  });

  it.each([
    ["en", en],
    ["ru", ru],
    ["uz", uz],
  ] as const)("every word has a sentence in %s that says nothing was charged", (_loc, dict) => {
    const errors = dict.creative.errors as Record<string, string>;
    for (const w of WORDS) {
      expect(errors[w], w).toBeTruthy();
      expect(errors[w]).not.toContain(w);
    }
  });

  it("each locale words them differently from English (not a copy left untranslated)", () => {
    for (const w of WORDS) {
      expect(ru.creative.errors[w]).not.toBe(en.creative.errors[w]);
      expect(uz.creative.errors[w]).not.toBe(en.creative.errors[w]);
    }
  });
});
