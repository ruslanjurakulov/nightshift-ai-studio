import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { KIT_LIMITS } from "../lib/style-kits";
import {
  DESCRIPTION_HARD_MAX,
  DESCRIPTION_SOFT_MAX,
  LIBRARY_ID_RE,
  STYLE_LIBRARY,
  STYLE_TAGS,
  TILE_MOTIFS,
  filterLibrary,
  kitNameFor,
  libraryStyleById,
  type LibraryStyle,
} from "../lib/styles/library";
import { parseLibraryAdd } from "../lib/styles/add";
import { hashSeed, luminance, tileShapes } from "../lib/styles/tile";

/**
 * The Style Library's content (lib/styles/library.ts). What would break without
 * these: an id that is not stable (an organization's kit remembers it), a
 * language with a hole in it, a description the database would refuse when it
 * is added (so "Add" fails for one style only), a brand, a living artist or a
 * real person's name in the words that go into a prompt, and a style that lost
 * its "avoid the stock-AI look" clause.
 */

const LOCALES = ["en", "ru", "uz"] as const;
const SQL_0047 = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0047_style_kits_characters.sql"), "utf8");

/** Brands, studios and IP a style must not name (the words go into a prompt). */
const BRANDS = [
  "pixar", "disney", "ghibli", "dreamworks", "marvel", "nintendo", "lego", "barbie", "pokemon", "pokémon", "netflix",
  "kodak", "kodachrome", "cinestill", "fujifilm", "fuji", "polaroid", "leica", "hasselblad", "ilford", "lomo",
  "instagram", "tiktok", "snapchat", "photoshop", "procreate", "pantone", "sharpie", "crayola", "copic",
  "midjourney", "dall-e", "stable diffusion", "unreal engine", "octane", "vray", "blender",
  "nike", "adidas", "coca-cola", "ikea", "apple", "starbucks", "aardman", "laika", "hanna-barbera",
];
/** Living artists, illustrators and directors (a prompt must not borrow a living person's name). */
const LIVING = [
  "banksy", "kusama", "murakami", "miyazaki", "kaws", "rutkowski", "beeple", "shepard fairey", "takashi", "yayoi",
  "tim burton", "wes anderson", "guillermo", "hockney", "koons", "hirst", "ai weiwei", "jeff koons", "damien hirst",
  "annie leibovitz", "steve mccurry", "mccurry", "leibovitz", "alex ross", "loish", "sam yang", "peter mohrbacher", "greg rutkowski",
];
/** Real-person likeness requests. */
const LIKENESS = /\b(?:portrait of|looks like|resembling|in the likeness|celebrity|president|politician)\b/i;

const hex = /^#[0-9a-f]{6}$/i;

describe("the library as a whole", () => {
  it("holds about thirty styles with unique, stable, well-formed ids", () => {
    expect(STYLE_LIBRARY.length).toBeGreaterThanOrEqual(24);
    expect(STYLE_LIBRARY.length).toBeLessThanOrEqual(36);
    const ids = STYLE_LIBRARY.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(LIBRARY_ID_RE.test(id), id).toBe(true);
      // 0065 refuses an id outside 2-48 characters; a longer one could never be added.
      expect(id.length).toBeGreaterThanOrEqual(2);
      expect(id.length).toBeLessThanOrEqual(48);
    }
  });

  it("covers the families the brief asked for", () => {
    const has = (id: string) => expect(libraryStyleById(id), id).not.toBeNull();
    // film and photo, print and paper, graphic traditions, craft, Central-Asian roots
    for (const id of [
      "night-street-16mm", "tungsten-night-film", "instant-print-flash", "tilt-shift-miniature", "darkroom-contact-sheet",
      "two-colour-risograph", "linocut-print", "cut-paper-collage", "newsprint-halftone", "blueprint-technical",
      "bauhaus-poster", "constructivist-poster", "ukiyo-e-woodblock", "art-nouveau-poster",
      "claymation-set", "felt-and-wool", "oil-pastel", "gouache-storybook",
      "ikat-atlas-silk", "suzani-embroidery", "timurid-tilework", "central-asian-miniature", "samarkand-golden-hour",
    ]) has(id);
  });

  it("is looked up by exact id only", () => {
    expect(libraryStyleById("bauhaus-poster")?.id).toBe("bauhaus-poster");
    expect(libraryStyleById("Bauhaus-Poster")).toBeNull();
    expect(libraryStyleById(" bauhaus-poster")).toBeNull();
    expect(libraryStyleById(undefined)).toBeNull();
    expect(libraryStyleById({ id: "bauhaus-poster" })).toBeNull();
  });
});

describe.each(STYLE_LIBRARY.map((s) => [s.id, s] as const))("%s", (_id, s: LibraryStyle) => {
  it("is written in all three languages, in the right script", () => {
    for (const l of LOCALES) {
      expect(s.name[l].trim().length, `name ${l}`).toBeGreaterThan(1);
      expect(s.goodFor[l].trim().length, `goodFor ${l}`).toBeGreaterThan(10);
      expect(s.name[l].length, `name ${l} fits a kit name`).toBeLessThanOrEqual(KIT_LIMITS.nameMax);
    }
    expect(s.name.ru).toMatch(/[А-Яа-яЁё]/);
    expect(s.goodFor.ru).toMatch(/[А-Яа-яЁё]/);
    // Uzbek is written in Latin script here, like the rest of the app.
    expect(s.name.uz).not.toMatch(/[А-Яа-яЁё]/);
    expect(s.goodFor.uz).not.toMatch(/[А-Яа-яЁё]/);
    // A translation that is the English line copied across is a hole.
    expect(s.goodFor.ru).not.toBe(s.goodFor.en);
    expect(s.goodFor.uz).not.toBe(s.goodFor.en);
    // No Latin letters hiding in a Cyrillic word (a classic paste slip): every word is one script.
    for (const text of [s.name.ru, s.goodFor.ru, s.name.uz, s.goodFor.uz]) {
      for (const word of text.split(/[^\p{L}]+/u)) expect(word, word).not.toMatch(/(?=.*\p{Script=Latin})(?=.*\p{Script=Cyrillic})/u);
    }
  });

  it("has a description the style kit table accepts, with room left for the person's own prompt", () => {
    expect(s.description.length).toBeLessThanOrEqual(DESCRIPTION_HARD_MAX);
    expect(s.description.length).toBeLessThanOrEqual(DESCRIPTION_SOFT_MAX);
    // Long enough to be a direction, not a label.
    expect(s.description.length).toBeGreaterThan(450);
    // Plain text: save_style_kit would strip control characters, and the worker joins lines anyway.
    expect(s.description).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(s.description).toBe(s.description.trim());
  });

  it("names what to avoid, always including the glossy symmetrical over-saturated stock-AI look", () => {
    expect(s.description).toMatch(/Avoid the glossy, symmetrical, over-saturated stock-AI look:/);
    // The clause comes last, and says something specific after the colon.
    const tail = s.description.split("Avoid the glossy, symmetrical, over-saturated stock-AI look:")[1];
    expect(tail.trim().length).toBeGreaterThan(40);
    expect(tail).not.toMatch(/Avoid/);
  });

  it("is concrete: it names colours, light, texture and composition", () => {
    expect(s.description).toMatch(/Palette:|palette/i);
    expect(s.description).toMatch(/\bLight\b|\blight\b|\blit\b/);
    expect(s.description).toMatch(/Texture|texture|grain|fibre|brush|grain/i);
    expect(s.description).toMatch(/Composition|composition/);
  });

  it("names no brand, studio or IP, no living artist and no real person", () => {
    const all = [s.id, s.description, ...LOCALES.flatMap((l) => [s.name[l], s.goodFor[l]])].join(" ").toLowerCase();
    for (const word of BRANDS) {
      // Whole-word match, so "apple" does not catch "Apple blossom" in another word's middle.
      const re = new RegExp(`(^|[^\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "u");
      expect(all, `brand: ${word}`).not.toMatch(re);
    }
    for (const word of LIVING) {
      const re = new RegExp(`(^|[^\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "u");
      expect(all, `living person: ${word}`).not.toMatch(re);
    }
    expect(s.description).not.toMatch(LIKENESS);
  });

  it("has 3-5 known tags, 3-5 valid hex colours, suggested formats and a known motif", () => {
    expect(s.tags.length).toBeGreaterThanOrEqual(3);
    expect(s.tags.length).toBeLessThanOrEqual(5);
    expect(new Set(s.tags).size).toBe(s.tags.length);
    for (const tag of s.tags) expect(STYLE_TAGS).toContain(tag);
    expect(s.swatch.length).toBeGreaterThanOrEqual(3);
    expect(s.swatch.length).toBeLessThanOrEqual(5);
    for (const c of s.swatch) expect(c).toMatch(hex);
    expect(new Set(s.swatch.map((c) => c.toLowerCase())).size).toBe(s.swatch.length);
    expect(s.aspects.length).toBeGreaterThanOrEqual(1);
    for (const a of s.aspects) expect(["16:9", "9:16", "1:1"]).toContain(a);
    expect(TILE_MOTIFS).toContain(s.motif);
  });
});

describe("limits and words", () => {
  it("the description limit is the one migration 0047 enforces, read from its CHECK", () => {
    const m = SQL_0047.match(/description\s+text not null default '' check \(char_length\(description\) <= (\d+)\)/);
    expect(m, "0047 style_kits.description CHECK").not.toBeNull();
    expect(DESCRIPTION_HARD_MAX).toBe(Number(m![1]));
    const name = SQL_0047.match(/name\s+text not null check \(char_length\(name\) between 1 and (\d+)/);
    expect(KIT_LIMITS.nameMax).toBe(Number(name![1]));
  });

  it("every tag has a label in all three languages, and none names a provider", () => {
    for (const d of [en, ru, uz]) {
      for (const tag of STYLE_TAGS) expect(d.styleLibrary.tags[tag].trim(), tag).not.toBe("");
      expect(Object.keys(d.styleLibrary.tags).sort()).toEqual([...STYLE_TAGS].sort());
    }
  });

  it("every tag is used by some style, so no filter chip is a dead end", () => {
    for (const tag of STYLE_TAGS) expect(STYLE_LIBRARY.some((s) => s.tags.includes(tag)), tag).toBe(true);
  });

  it("the screen's own copy names no AI provider, model or competitor, and is complete in every language", () => {
    const brands = /krea|higgsfield|magiclight|kling|capcut|inshot|midjourney|openai|gemini|elevenlabs|moodboard|lora|soul id|runway|sora|flux/i;
    function keys(o: unknown, prefix = ""): string[] {
      return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        v && typeof v === "object" ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
      );
    }
    for (const d of [en, ru, uz]) {
      expect(JSON.stringify(d.styleLibrary)).not.toMatch(brands);
      expect(JSON.stringify(d.styleLibrary)).not.toMatch(/\b(?:owner|editor|viewer)\b/i);
    }
    expect(keys(ru.styleLibrary)).toEqual(keys(en.styleLibrary));
    expect(keys(uz.styleLibrary)).toEqual(keys(en.styleLibrary));
    for (const d of [ru, uz]) {
      expect(d.styleLibrary.title).not.toBe(en.styleLibrary.title);
      expect(d.nav.styles).not.toBe("");
      expect(d.gen.styleBrowse).not.toBe(en.gen.styleBrowse);
      // "Palette preview" is the honest label; each language has its own words for it.
      expect(d.styleLibrary.previewLabel).not.toBe(en.styleLibrary.previewLabel);
    }
    expect(en.styleLibrary.previewLabel).toBe("Palette preview");
  });

  it("saves a kit under the person's language, within the kit name limit", () => {
    const s = libraryStyleById("night-street-16mm")!;
    expect(kitNameFor(s, "ru")).toBe(s.name.ru);
    expect(kitNameFor(s, "uz")).toBe(s.name.uz);
    expect(kitNameFor(s, "en")).toBe(s.name.en);
    for (const st of STYLE_LIBRARY) for (const l of LOCALES) expect([...kitNameFor(st, l)].length).toBeLessThanOrEqual(60);
  });
});

describe("search and tag filters", () => {
  const labels = en.styleLibrary.tags;
  const ids = (q: string, tags: Parameters<typeof filterLibrary>[1]["tags"] = [], locale: "en" | "ru" | "uz" = "en") =>
    filterLibrary(STYLE_LIBRARY, { query: q, tags }, locale, locale === "en" ? labels : locale === "ru" ? ru.styleLibrary.tags : uz.styleLibrary.tags).map((s) => s.id);

  it("shows everything with no query and no tags", () => {
    expect(ids("")).toHaveLength(STYLE_LIBRARY.length);
  });

  it("finds a style by its name in any language, whatever the case", () => {
    expect(ids("RISOGRAPH")).toContain("two-colour-risograph");
    expect(ids("ризограф", [], "ru")).toContain("two-colour-risograph");
    expect(ids("rizograf", [], "uz")).toContain("two-colour-risograph");
    // An English name typed into a Russian screen still finds it.
    expect(ids("linocut", [], "ru")).toContain("linocut-print");
  });

  it("treats ё and е alike, and needs every word of the query", () => {
    expect(ids("ночная улица", [], "ru")).toContain("night-street-16mm");
    expect(ids("night street")).toContain("night-street-16mm");
    expect(ids("night zzzz")).toEqual([]);
  });

  it("finds by a tag's word and by what it is good for", () => {
    expect(ids("kids")).toContain("claymation-set");
    expect(ids("lessons")).toContain("chalk-on-slate");
  });

  it("narrows by tags: a style must carry every picked tag", () => {
    const kids = ids("", ["kids"]);
    expect(kids.length).toBeGreaterThan(0);
    for (const id of kids) expect(libraryStyleById(id)!.tags).toContain("kids");
    const both = ids("", ["kids", "shorts"]);
    expect(both.length).toBeLessThanOrEqual(kids.length);
    for (const id of both) expect(libraryStyleById(id)!.tags).toEqual(expect.arrayContaining(["kids", "shorts"]));
    expect(ids("blueprint", ["kids"])).toEqual([]);
  });
});

describe("the palette preview tile", () => {
  it("draws the same tile for the same style, and only in the style's own colours", () => {
    for (const s of STYLE_LIBRARY) {
      const a = tileShapes(s);
      expect(tileShapes(s)).toEqual(a);
      const fills = [a.ground, a.disc.fill, a.band.fill, a.wedge.fill, a.dot.fill, a.ink, a.paper];
      for (const f of fills) expect(s.swatch, `${s.id} ${f}`).toContain(f);
      expect(luminance(a.ink)).toBeLessThanOrEqual(luminance(a.paper));
    }
    expect(hashSeed("a")).not.toBe(hashSeed("b"));
  });
});

describe("POST body for adding a style", () => {
  it("accepts a library id and picks the kit's name in the person's language", () => {
    const r = parseLibraryAdd({ library_id: "linocut-print", locale: "ru" });
    expect(r.ok && r.value.name).toBe(libraryStyleById("linocut-print")!.name.ru);
  });

  it("falls back to English for an unknown language, and refuses unknown or malformed ids", () => {
    const r = parseLibraryAdd({ library_id: "linocut-print", locale: "xx" });
    expect(r.ok && r.value.name).toBe(libraryStyleById("linocut-print")!.name.en);
    for (const bad of [null, [], "x", {}, { library_id: "nope" }, { library_id: "../etc" }, { library_id: ["linocut-print"] }, { library_id: "LINOCUT-PRINT" }]) {
      expect(parseLibraryAdd(bad)).toEqual({ ok: false, error: "bad_request" });
    }
  });
});
