import { describe, expect, it } from "vitest";
import { dictionaries } from "@/lib/i18n";

/**
 * Every string the plan step and the model gate added to the panel, in en, ru and uz (Probe on S1). What breaks if these fail: a
 * Russian or Uzbek person reads an English (or empty) line in the middle of a failed plan; a placeholder missing in one language
 * prints "{needed}" or drops the number that is the whole point of the message; Uzbek's oʻ / gʻ typed with an ASCII apostrophe
 * (or the tutuq belgisi with the wrong mark), which reads as a typo and breaks search and screen readers.
 */

const LOCALES = ["en", "ru", "uz"] as const;
type Tree = { [k: string]: string | string[] | Tree };
const at = (t: Tree, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Tree)[k] : undefined), t);
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
function leaves(t: Tree, prefix = ""): [string, string][] {
  return Object.entries(t).flatMap(([k, v]): [string, string][] =>
    typeof v === "string" ? [[prefix + k, v]] : Array.isArray(v) ? v.map((x, i): [string, string] => [`${prefix}${k}.${i}`, x]) : leaves(v, `${prefix}${k}.`));
}
const ai = (l: (typeof LOCALES)[number]) => dictionaries[l].aiChat as unknown as Tree;

const NEW = [
  "outlineFacts", "planWriting",
  "errors.plan_failed", "errors.plan_failed_plain", "errors.plan_length_mismatch", "errors.plan_length_mismatch_plain", "errors.plan_over_cap",
  "errors.plan_running", "errors.plan_unavailable", "errors.plan_superseded", "errors.proposal_outdated", "planCost", "planCostTrial", "planCostPlain",
  "messageCount.one", "messageCount.other", "messagesLeft.one", "messagesLeft.other", "modelVideo", "modelPictures",
  // The model gate's words are by remedy since #898's lib/brain/chat-gate (one wording before a press and after one).
  "gate.retry", "gate.not_in_region", "gate.contact_support", "gate.contact_support_no_email", "gate.contact",
  ...Object.keys(dictionaries.en.aiChat.shell).map((k) => `shell.${k}`),
  ...Object.keys(dictionaries.en.aiChat.history).map((k) => `history.${k}`),
];

describe("the plan step's strings in three languages", () => {
  for (const path of NEW) {
    it(`${path}: present and non-empty in en, ru and uz, with the same placeholders`, () => {
      const en = at(ai("en"), path);
      for (const l of LOCALES) {
        const v = at(ai(l), path);
        expect(v, `${l}.${path}`).toBeDefined();
        if (Array.isArray(v)) {
          expect((v as string[]).length).toBe((en as string[]).length);
          continue;
        }
        expect(typeof v).toBe("string");
        expect((v as string).trim().length, `${l}.${path}`).toBeGreaterThan(0);
        expect(placeholders(v as string), `${l}.${path}`).toEqual(placeholders(en as string));
      }
    });
  }

  it("ru and uz are not English copies of the plan's lines", () => {
    for (const path of NEW.filter((p) => /^(errors\.|gate\.|planWriting|outlineFacts|planCost)/.test(p))) {
      expect(at(ai("ru"), path), path).not.toBe(at(ai("en"), path));
      expect(at(ai("uz"), path), path).not.toBe(at(ai("en"), path));
    }
  });

  it("the panel's whole dictionary has the same keys in every language", () => {
    const keys = (l: (typeof LOCALES)[number]) => leaves(ai(l)).map(([k]) => k).sort();
    expect(keys("ru")).toEqual(keys("en"));
    expect(keys("uz")).toEqual(keys("en"));
  });
});

describe("Uzbek's two marks", () => {
  const uz = leaves(ai("uz"));

  it("oʻ and gʻ use U+02BB, and no Uzbek string uses an ASCII apostrophe, a backtick or a curly quote between letters", () => {
    const bad = uz.filter(([, v]) => /\p{L}['`‘’]\p{L}/u.test(v));
    expect(bad).toEqual([]);
  });

  it("o and g before a mark take U+02BB (ʻ), never the tutuq belgisi U+02BC (ʼ)", () => {
    const bad = uz.filter(([, v]) => /[oOgG]ʼ/.test(v));
    expect(bad).toEqual([]);
  });

  it("the plan's Uzbek lines actually carry U+02BB where the words need it (koʻring, boʻlmadi, soʻng)", () => {
    expect(dictionaries.uz.aiChat.errors.plan_failed).toContain("boʻlmadi");
    expect(dictionaries.uz.aiChat.errors.plan_failed).toContain("koʻring");
    expect(dictionaries.uz.aiChat.gate.retry).toContain("soʻng");
  });
});
