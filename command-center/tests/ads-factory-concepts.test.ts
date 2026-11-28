/**
 * Concept drafts from fixed templates (lib/adsFactory/concepts.ts): no model, no price, the same input gives the same drafts.
 * What would break without these: a retry of one press sending the database different words (so it is a conflict, not a replay), a
 * draft the database refuses (too long, a beat with nothing seen, a format the campaign did not choose), a template that makes a
 * claim nobody typed ("best", a discount, a promise), names another product or a model, leaves a {placeholder} in an ad, or expands
 * a product called "{brand}" a second time.
 */
import { describe, expect, it } from "vitest";
import { CONCEPT_TEMPLATES, buildConceptDrafts, clip, type DraftProduct } from "../lib/adsFactory/concepts";
import {
  ADS_LIMITS,
  AD_DIRECTIONS,
  AD_FORMAT_IDS,
  AD_KINDS,
  AD_LANGUAGES,
  AD_OBJECTIVES,
  charLength,
  cleanBlock,
  cleanLine,
  parseBeats,
} from "../lib/adsFactory/model";
import { bannedHits } from "../lib/marketing-banned";

const P = (n: number, over: Partial<DraftProduct> = {}): DraftProduct => ({
  id: `0a000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  title: `Product ${n}`,
  description: "",
  price: "",
  ...over,
});
const brand = { name: "Acme", palette: ["#112233", "#aabbcc"] };
const campaign = { objective: "sales", language: "en", formats: ["1:1", "9:16"], directions: ["spotlight", "minimal"] } as const;

function leaves(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (node && typeof node === "object") return Object.values(node).flatMap(leaves);
  return [];
}

describe("buildConceptDrafts", () => {
  it("is deterministic: the same input gives byte-identical drafts", () => {
    const input = { brand, products: [P(1), P(2)], campaign, kind: "video" as const, count: 12 };
    expect(JSON.stringify(buildConceptDrafts(input))).toBe(JSON.stringify(buildConceptDrafts(structuredClone(input))));
  });

  it("covers every product first, then every format, then every direction, and only then repeats with a second headline", () => {
    const drafts = buildConceptDrafts({ brand, products: [P(1), P(2), P(3)], campaign, kind: "image", count: 12 });
    expect(drafts.map((d) => `${d.product_id?.slice(-1)} ${d.format} ${d.direction}`)).toEqual([
      "1 1:1 spotlight", "2 1:1 spotlight", "3 1:1 spotlight",
      "1 9:16 spotlight", "2 9:16 spotlight", "3 9:16 spotlight",
      "1 1:1 minimal", "2 1:1 minimal", "3 1:1 minimal",
      "1 9:16 minimal", "2 9:16 minimal", "3 9:16 minimal",
    ]);
    const one = buildConceptDrafts({ brand, products: [P(1)], campaign: { ...campaign, formats: ["1:1"], directions: ["bold"] }, kind: "image", count: 3 });
    expect(one.map((d) => d.headline)).toEqual(["Product 1 is ready when you are", "Bring home Product 1", "Product 1 is ready when you are"]);
  });

  it("makes between 1 and 12, whatever is asked", () => {
    const n = (count: number) => buildConceptDrafts({ brand, products: [P(1)], campaign, kind: "image", count }).length;
    expect([n(0), n(-5), n(1), n(12), n(13), n(1000), n(Number.NaN), n(2.9)]).toEqual([1, 1, 1, 12, 12, 12, 1, 2]);
  });

  it("makes nothing when there is nothing to plan from", () => {
    expect(buildConceptDrafts({ brand, products: [], campaign, kind: "image", count: 4 })).toEqual([]);
    expect(buildConceptDrafts({ brand: { name: "  ", palette: [] }, products: [P(1)], campaign, kind: "image", count: 4 })).toEqual([]);
    expect(buildConceptDrafts({ brand, products: [P(1)], campaign: { ...campaign, formats: [] }, kind: "image", count: 4 })).toEqual([]);
    expect(buildConceptDrafts({ brand, products: [P(1)], campaign: { ...campaign, directions: [] }, kind: "image", count: 4 })).toEqual([]);
  });

  it("uses only what the person typed: the description's first sentence, the price as text, the colours", () => {
    const [d] = buildConceptDrafts({
      brand,
      products: [P(1, { title: "Green tea", description: "Grown in the hills. Picked by hand.", price: "$12" })],
      campaign: { ...campaign, objective: "offer" },
      kind: "video",
      count: 1,
    });
    expect(d.headline).toBe("Green tea: $12");
    expect(d.body).toBe("Grown in the hills.");
    expect(d.cta).toBe("See the offer");
    expect(d.visual_brief).toContain("Brand colours: #112233, #aabbcc.");
    expect(d.storyboard).toHaveLength(4);
    expect(d.storyboard?.[3]).toEqual({ visual: "End card: the logo, the name Green tea and the price $12.", line: "See the offer" });
    // No price typed: no price anywhere, and no offer invented.
    const [bare] = buildConceptDrafts({ brand: { name: "Acme", palette: [] }, products: [P(1)], campaign: { ...campaign, objective: "offer" }, kind: "video", count: 1 });
    expect(bare.headline).toBe("Acme presents: Product 1");
    expect(bare.visual_brief).not.toMatch(/colours/i);
    expect(JSON.stringify(bare)).not.toMatch(/price|\$|discount|sale\b|% off/i);
  });

  it("an image draft has no storyboard and a video draft always has one the database takes", () => {
    for (const kind of AD_KINDS) {
      for (const d of buildConceptDrafts({ brand, products: [P(1)], campaign, kind, count: 4 })) {
        if (kind === "image") expect(d.storyboard).toBeNull();
        else expect(parseBeats(d.storyboard)).toEqual(d.storyboard);
      }
    }
  });

  it("a product called like a placeholder stays those characters, and hostile text is cleaned out", () => {
    const zw = String.fromCodePoint(0x200b);
    const rlo = String.fromCodePoint(0x202e);
    const [d] = buildConceptDrafts({
      brand: { name: `Ac${zw}me\n<script>`, palette: ["url(x)", "#ABCDEF", "#00ff00"] },
      products: [P(1, { title: `{brand} {price} ${rlo}tea\r\n`, description: `First${zw} line.\nSecond.`, price: "{product}" })],
      campaign: { ...campaign, objective: "awareness" },
      kind: "video",
      count: 1,
    });
    expect(d.headline).toBe("Meet {brand} {price} tea");
    expect(d.body).toBe("First line.");
    expect(d.visual_brief).toContain("Brand colours: #00ff00.");
    expect(d.storyboard?.[2].line).toBe("By Acme <script>.");
    const all = JSON.stringify(d);
    expect(all).not.toContain(zw);
    expect(all).not.toContain(rlo);
  });

  // The full matrix (2,400 drafts) takes ~3.3 s alone and went past Vitest's 5 s default when the
  // suite shared a 2-core runner with another run. The matrix is the point of this test, so it gets
  // the time rather than a smaller matrix.
  it("every combination of language, objective, direction, format and kind gives a draft within the database's limits", () => {
    const long = P(1, { title: "W".repeat(120), description: `${"long ".repeat(250)}.`, price: "9".repeat(40) });
    let seen = 0;
    for (const language of AD_LANGUAGES) for (const objective of AD_OBJECTIVES) for (const direction of AD_DIRECTIONS) for (const format of AD_FORMAT_IDS) for (const kind of AD_KINDS) {
      for (const product of [P(1), long]) {
        const drafts = buildConceptDrafts({ brand: { name: "B".repeat(80), palette: brand.palette }, products: [product], campaign: { objective, language, formats: [format], directions: [direction] }, kind, count: 2 });
        expect(drafts).toHaveLength(2);
        for (const d of drafts) {
          seen++;
          const where = `${language} ${objective} ${direction} ${format} ${kind}`;
          expect(Object.keys(d).sort(), where).toEqual(["body", "cta", "direction", "format", "headline", "kind", "product_id", "storyboard", "visual_brief"]);
          expect(charLength(d.headline), where).toBeGreaterThanOrEqual(1);
          expect(charLength(d.headline), where).toBeLessThanOrEqual(ADS_LIMITS.headline);
          expect(charLength(d.body), where).toBeLessThanOrEqual(ADS_LIMITS.body);
          expect(charLength(d.cta), where).toBeLessThanOrEqual(ADS_LIMITS.cta);
          expect(charLength(d.visual_brief), where).toBeLessThanOrEqual(ADS_LIMITS.brief);
          // Already what the database would store: cleaning it again changes nothing.
          expect(cleanLine(d.headline), where).toBe(d.headline);
          expect(cleanBlock(d.body), where).toBe(d.body);
          expect(cleanLine(d.cta), where).toBe(d.cta);
          expect(cleanBlock(d.visual_brief), where).toBe(d.visual_brief);
          expect(JSON.stringify(d), where).not.toMatch(/\{(product|brand|price|palette)\}/);
          expect([d.format, d.direction, d.kind], where).toEqual([format, direction, kind]);
        }
      }
    }
    expect(seen).toBe(3 * 5 * 5 * 4 * 2 * 2 * 2);
  }, 30_000);
});

describe("the templates themselves", () => {
  it.each(AD_LANGUAGES)("%s: every template is filled in for every objective, direction and format, and uses only known placeholders", (language) => {
    const t = CONCEPT_TEMPLATES[language];
    expect(Object.keys(t.headline).sort()).toEqual([...AD_OBJECTIVES].sort());
    expect(Object.keys(t.cta).sort()).toEqual([...AD_OBJECTIVES].sort());
    for (const group of [t.body, t.look, t.open]) expect(Object.keys(group).sort()).toEqual([...AD_DIRECTIONS].sort());
    expect(Object.keys(t.frame).sort()).toEqual([...AD_FORMAT_IDS].sort());
    for (const text of leaves(t)) {
      expect(text.trim()).not.toBe("");
      for (const m of text.matchAll(/\{(\w+)\}/g)) expect(["product", "brand", "price", "palette"], text).toContain(m[1]);
    }
    for (const o of AD_OBJECTIVES) for (const h of t.headline[o]) expect(h, `${language} ${o}`).toContain("{product}");
    // A price appears only in the two templates that exist for a price the person typed.
    for (const text of leaves(t)) if (text.includes("{price}")) expect([t.headlineWithPrice, t.endCardWithPrice]).toContain(text);
  });

  it.each(AD_LANGUAGES)("%s: no claim nobody typed, no model or vendor name, no other product", (language) => {
    const text = leaves(CONCEPT_TEMPLATES[language]).join("\n");
    expect(bannedHits({ [language]: text })).toEqual([]);
    expect(text).not.toMatch(/\b(sale|discount|off|deal|cheap|limited|hurry|today only|now only|save)\b/i);
    expect(text).not.toMatch(/скидк|распродаж|акци[яи]|только сегодня|успей|дешев/i);
    expect(text).not.toMatch(/chegirma|aksiya|faqat bugun|arzon|shoshiling/i);
    expect(text).not.toMatch(/\bAI\b|artificial|generated|model\b/i);
  });

  it("ru and uz are not left in English", () => {
    const en = leaves(CONCEPT_TEMPLATES.en);
    for (const language of ["ru", "uz"] as const) {
      const other = leaves(CONCEPT_TEMPLATES[language]);
      expect(other).toHaveLength(en.length);
      const same = other.filter((s, i) => s === en[i]);
      // The one line that is only placeholders and a colon reads the same in every language.
      expect(same).toEqual(["{product}: {price}"]);
    }
    expect(leaves(CONCEPT_TEMPLATES.ru).join(" ")).toMatch(/[а-я]/);
    expect(leaves(CONCEPT_TEMPLATES.uz).join(" ")).not.toMatch(/[а-я]/i);
  });
});

describe("clip", () => {
  it("cuts by characters, at a space when one is near, and invents no ellipsis", () => {
    expect(clip("short", 10)).toBe("short");
    expect(clip("one two three four", 13)).toBe("one two three");
    expect(clip("one two three four", 12)).toBe("one two");
    expect(clip("x".repeat(20), 7)).toBe("xxxxxxx");
    expect(clip("🍵".repeat(5), 3)).toBe("🍵🍵🍵");
    expect(clip("a title, with a comma,", 21)).toBe("a title, with a comma");
  });
});
