import { describe, expect, it } from "vitest";
import { LEGAL_TEXTS, type LegalBlock, type LegalDocument } from "@/lib/legal-docs";
import { tokenizeInline } from "@/lib/legal-docs/inline";

/**
 * Owner decision D5 (2026-11-22). Google is a sub-processor for Studio generation, not only for pipeline text, and the
 * Google APIs Terms (section 2(a)) require the Terms to pass Google's conditions down to the people who use its models.
 * If one of these fails, the Studio is offering a Google model under texts that no longer say so.
 */

const GEMINI_TERMS = "https://ai.google.dev/gemini-api/terms";
const PROHIBITED_USE = "https://policies.google.com/terms/generative-ai/use-policy";
const USAGE_POLICIES = "https://aistudio.google.com/docs/usage-policies";
const REGIONS = "https://ai.google.dev/gemini-api/docs/available-regions";

const strings = (b: LegalBlock): string[] =>
  typeof b === "string" ? [b] : "list" in b ? b.list : "note" in b ? [b.note] : "table" in b ? [...b.table.head, ...b.table.rows.flat()] : [];
const section = (doc: LegalDocument, id: string) => doc.sections.find((s) => s.id === id)!;
const textOf = (doc: LegalDocument, id: string) => section(doc, id).body.flatMap(strings).join(" ");
const linksOf = (doc: LegalDocument, id: string) =>
  section(doc, id).body.flatMap(strings).flatMap(tokenizeInline).flatMap((t) => (t.kind === "link" ? [t.href] : []));

describe.each(["en", "ru", "uz"] as const)("%s: Google models in the legal texts (D5)", (locale) => {
  const { privacy, terms } = LEGAL_TEXTS[locale];

  it("the processor table has a Google row for the Studio that names the prompt and the uploaded picture or video", () => {
    const table = section(privacy, "processors").body.find((b) => typeof b === "object" && "table" in b) as { table: { rows: string[][] } };
    const studio = table.table.rows.filter((r) => r[0].startsWith("Google — Gemini API,"));
    expect(studio).toHaveLength(1);
    const [, , data] = studio[0];
    const words = { en: ["prompt", "picture or video"], ru: ["запрос", "изображение или видео"], uz: ["Soʻrovingiz", "rasm yoki video"] }[locale];
    for (const w of words) expect(data, w).toContain(w);
  });

  it("section 7 restates Google's retention as Google states it: no training on the paid service, 55 days, SynthID", () => {
    const text = textOf(privacy, "processors");
    expect(text).toContain("(55)");
    expect(text).toContain("SynthID");
    expect(linksOf(privacy, "processors")).toEqual(expect.arrayContaining([PROHIBITED_USE, USAGE_POLICIES, GEMINI_TERMS]));
  });

  it("the Terms pass Google's conditions down: law, both Google documents, 18+, no deceptive human claim, the watermark, regions", () => {
    const third = section(terms, "third-parties");
    expect(linksOf(terms, "third-parties")).toEqual(expect.arrayContaining([GEMINI_TERMS, PROHIBITED_USE, REGIONS]));
    const list = third.body.find((b) => typeof b === "object" && "list" in b) as { list: string[] };
    expect(list.list).toHaveLength(4);
    expect(list.list[0]).toContain("18");
    expect(list.list[2]).toContain("6.3");
  });

  // Section 6 names no model maker (tests/legal-docs.test.ts); the pass-down must not have been put there.
  it("section 6 still names no Google document", () => {
    expect(linksOf(terms, "acceptable-use")).not.toEqual(expect.arrayContaining([GEMINI_TERMS]));
  });
});
