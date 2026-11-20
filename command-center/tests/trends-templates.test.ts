import { readFileSync } from "node:fs";
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
import { CUSTOMER_RAIL, CUSTOMER_SECTIONS, CUSTOMER_SIDEBAR } from "@/lib/navigation";
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
  preview_asset_path: null,
  poster_path: null,
  sort: 80,
  ...over,
});

const SB = "https://proj.supabase.co";

describe("trend template rows", () => {
  it("drops a row missing a translation instead of drawing a blank card", () => {
    expect(coerceTemplateRows([row({ title: { en: "x", ru: "y" } })])).toEqual([]);
  });

  it("drops a video with a length Create cannot hold, and an image with a length at all", () => {
    expect(coerceTemplateRows([row({ duration_s: 7 })])).toEqual([]);
    expect(coerceTemplateRows([row({ kind: "image", duration_s: 5 })])).toEqual([]);
  });

  it("never turns a media path that leaves our bucket into a URL", () => {
    for (const p of ["https://evil.example/x.mp4", "../x.mp4", "a/../../x.mp4", "/x.mp4", "x.html"]) {
      const [r] = coerceTemplateRows([row({ preview_asset_path: p })]);
      expect(r.previewPath, p).toBeNull();
      expect(toDto(r, "en", null, SB).preview_url, p).toBeUndefined();
    }
  });

  it("builds a public URL in the template bucket only", () => {
    expect(templateMediaUrl(SB, "food-reveal/preview.mp4")).toBe(
      "https://proj.supabase.co/storage/v1/object/public/template-media/food-reveal/preview.mp4",
    );
    expect(templateMediaUrl("", "food-reveal/preview.mp4")).toBeNull();
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
    const dto = toDto(r, "ru", { t2v: new Set(["minimax-h3"]), t2i: new Set() }, SB);
    expect(dto.model_available).toBe(true);
    expect(dto.model_status).toBe("available");
    expect(dto.title).toBe("Подача блюда");
  });

  it("is a measured false when the model is not on sale — and no other model is named", () => {
    const dto = toDto(r, "en", { t2v: new Set(["minimax-h3-lite"]), t2i: new Set(["minimax-h3"]) }, SB);
    expect(dto.model_available).toBe(false);
    expect(dto.model_status).toBe("unavailable");
    expect(dto.model_id).toBe("minimax-h3");
  });

  it("reads unknown, never available, when the registry could not answer", () => {
    const dto = toDto(r, "uz", null, SB);
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
  it("is on the customer rail and sidebar and a customer may open it", () => {
    expect(CUSTOMER_RAIL.some((i) => i.key === "trends")).toBe(true);
    expect(CUSTOMER_SIDEBAR.work.some((i) => i.key === "trends")).toBe(true);
    expect(CUSTOMER_SECTIONS).toContain("trends");
  });

  it("has every string in all three languages", () => {
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(ru.trends)).toEqual(keys(en.trends));
    expect(keys(uz.trends)).toEqual(keys(en.trends));
    expect(uz.nav.trends).toBe("Trendlar");
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
