import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  coerceTemplateRows,
  parseListQuery,
  placeholdersOf,
  templateCreateHref,
  templateMediaUrl,
  toDto,
} from "@/lib/templates/trends";
import { CUSTOMER_SECTIONS } from "@/lib/navigation";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

const row = (over: Record<string, unknown> = {}) => ({
  slug: "food-reveal",
  title: { en: "Food reveal", ru: "Подача блюда", uz: "Taom taqdimoti" },
  description: { en: "d-en", ru: "d-ru", uz: "d-uz" },
  category: "lifestyle",
  kind: "video",
  prompt_template: "Vertical food reveal of {dish}. Then {dish} again on {table}.",
  model_id: "minimax-h3",
  aspect: "9:16",
  duration_s: 5,
  quality: "768p",
  director: { camera: "pull back" },
  sort: 80,
  ...over,
});

const NONE = {};
const BOTH = { "food-reveal": { preview: true, poster: true } };

describe("trend template rows", () => {
  it("drops a row missing a translation instead of drawing a blank card", () => {
    expect(coerceTemplateRows([row({ title: { en: "x", ru: "y" } })])).toEqual([]);
  });

  it("drops a video with a length Create cannot hold, and an image with a length at all", () => {
    expect(coerceTemplateRows([row({ duration_s: 7 })])).toEqual([]);
    expect(coerceTemplateRows([row({ kind: "image", duration_s: 5 })])).toEqual([]);
  });

  it("names a media file only when the manifest says it ships, and only under /templates", () => {
    const [r] = coerceTemplateRows([row()]);
    expect(toDto(r, "en", null, NONE).preview_url).toBeUndefined();
    const dto = toDto(r, "en", null, BOTH);
    expect(dto.preview_url).toBe("/templates/food-reveal/preview.mp4");
    expect(dto.poster_url).toBe("/templates/food-reveal/poster.webp");
    expect(templateMediaUrl(BOTH, "../etc", "preview")).toBeNull();
  });

  it("lists each placeholder once, in order", () => {
    expect(placeholdersOf("A {dish} on {table}, {dish}")).toEqual(["dish", "table"]);
  });

  it("sorts by the stored order", () => {
    const rows = coerceTemplateRows([row({ slug: "b-two", sort: 20 }), row({ slug: "a-one", sort: 10 })]);
    expect(rows.map((r) => r.slug)).toEqual(["a-one", "b-two"]);
  });
});

describe("model availability", () => {
  const [r] = coerceTemplateRows([row()]);
  it("is true only when the registry sells that model for the template's tool", () => {
    const dto = toDto(r, "ru", { t2v: new Set(["minimax-h3"]), t2i: new Set() }, NONE);
    expect(dto.model_available).toBe(true);
    expect(dto.model_status).toBe("available");
    expect(dto.title).toBe("Подача блюда");
  });

  it("is a measured false when the model is not on sale — and no other model is named", () => {
    const dto = toDto(r, "en", { t2v: new Set(["minimax-h3-lite"]), t2i: new Set(["minimax-h3"]) }, NONE);
    expect(dto.model_available).toBe(false);
    expect(dto.model_status).toBe("unavailable");
    expect(dto.model_id).toBe("minimax-h3");
  });

  it("reads unknown, never available, when the registry could not answer", () => {
    const dto = toDto(r, "uz", null, NONE);
    expect(dto.model_available).toBe(false);
    expect(dto.model_status).toBe("unknown");
  });
});

describe("the list query", () => {
  it("refuses an unknown category instead of reading it as all", () => {
    expect(parseListQuery(new URLSearchParams("category=nope"))).toEqual({ ok: false, error: "bad_category" });
  });
  it("bounds the limit", () => {
    expect(parseListQuery(new URLSearchParams("limit=0")).ok).toBe(false);
    expect(parseListQuery(new URLSearchParams("limit=51")).ok).toBe(false);
    expect(parseListQuery(new URLSearchParams("limit=6&category=text&locale=uz"))).toEqual({
      ok: true,
      category: "text",
      limit: 6,
      locale: "uz",
    });
  });
  it("opens Create with the slug, which S1 reads", () => {
    expect(templateCreateHref("food-reveal")).toBe("/create?template=food-reveal");
  });
});

describe("the Trends entry", () => {
  // The rail and sidebar entries arrive with the Create stream's new rail (#816); here a customer may open the page.
  it("is a section a customer may open", () => {
    expect(CUSTOMER_SECTIONS).toContain("trends");
  });

  it("has every string in all three languages", () => {
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(ru.trends)).toEqual(keys(en.trends));
    expect(keys(uz.trends)).toEqual(keys(en.trends));
    expect(uz.nav.trends).toBe("Trendlar");
  });
});

describe("the media manifest", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "../lib/templates/media-manifest.json"), "utf8")) as Record<
    string,
    { preview?: boolean; poster?: boolean }
  >;
  it("claims a file only when the file is committed under public/templates", () => {
    for (const [slug, m] of Object.entries(manifest)) {
      for (const [key, file] of [["preview", "preview.mp4"], ["poster", "poster.webp"]] as const) {
        const there = existsSync(join(__dirname, "../public/templates", slug, file));
        if (m[key]) expect(there, `${slug}/${file} is in the manifest but not in public/`).toBe(true);
        else expect(there, `${slug}/${file} ships but the manifest hides it`).toBe(false);
      }
    }
  });
});

describe("migration 0181's seed", () => {
  const sql = readFileSync(join(__dirname, "../../supabase/migrations/0181_creative_templates.sql"), "utf8");
  const seeded = [...sql.matchAll(/'(minimax-h3[a-z-]*|ideogram-[0-9.]+|[a-z0-9.-]+)', '(9:16|16:9|1:1)'/g)].map((m) => m[1]);

  it("uses only the models on sale when it was written", () => {
    const onSale = ["minimax-h3", "minimax-h3-highspeed", "minimax-h3-lite", "minimax-h3-max", "ideogram-3", "ideogram-4", "ideogram-4.5"];
    expect(seeded.length).toBe(10);
    for (const m of seeded) expect(onSale).toContain(m);
  });

  it("never overwrites an owner's edit on re-apply", () => {
    expect(sql).toMatch(/on conflict \(slug\) do nothing;\s*$/);
  });
});

describe("migration 0191's seed (the viral set)", () => {
  const sql = readFileSync(join(__dirname, "../../supabase/migrations/0191_viral_templates.sql"), "utf8");
  const seeded = [...sql.matchAll(/'(minimax-h3[a-z-]*|ideogram-[0-9.]+|[a-z0-9.-]+)', '(9:16|16:9|1:1)'/g)].map((m) => m[1]);
  const categories = [...sql.matchAll(/^\s+'([a-z]+)', '(video|image)',$/gm)].map((m) => m[1]);

  it("uses only the models on sale when it was written", () => {
    const onSale = ["minimax-h3", "minimax-h3-highspeed", "minimax-h3-lite", "minimax-h3-max", "ideogram-3", "ideogram-4", "ideogram-4.5"];
    expect(seeded.length).toBe(10);
    for (const m of seeded) expect(onSale).toContain(m);
  });

  it("widens the category CHECK without dropping a category 0181's rows already use", () => {
    expect(sql).toContain("check (category in ('business', 'story', 'lifestyle', 'text', 'viral'))");
  });

  it("seeds only categories the gallery can draw a chip for, in every language", async () => {
    const { TEMPLATE_CATEGORIES } = await import("@/lib/templates/trends");
    const { trendsEn } = await import("@/lib/i18n/trends/en");
    expect(categories.length).toBe(10);
    for (const c of categories) {
      expect(TEMPLATE_CATEGORIES as readonly string[]).toContain(c);
      expect((trendsEn.categories as Record<string, string>)[c], c).toBeTruthy();
    }
  });

  it("never overwrites an owner's edit on re-apply", () => {
    expect(sql).toMatch(/on conflict \(slug\) do nothing;\s*$/);
  });
});

describe("the slug", () => {
  it("can never be a Studio starter id, which shares ?template=", async () => {
    const { SLUG_RE } = await import("@/lib/templates/trends");
    const { TEMPLATE_IDS } = await import("@/lib/creative/templates");
    for (const id of TEMPLATE_IDS) expect(SLUG_RE.test(id), id).toBe(false);
    expect(SLUG_RE.test("food-reveal")).toBe(true);
    expect(SLUG_RE.test("sharpen")).toBe(false);
  });
});
