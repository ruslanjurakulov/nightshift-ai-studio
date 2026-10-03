/**
 * What a price unit means in plain words (lib/creditUnits.ts): read off the
 * unit's name where the name settles it, and nothing at all otherwise — a
 * gloss that guessed would put a wrong promise on the price list.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { unitMeaning } from "../lib/creditUnits";
import { LEDGER_UNITS, SPECIAL_UNITS, chargePerUnit, isFlatUnit } from "../lib/credits";

const m = (unit: string, t = en) => unitMeaning(unit, t.credits.unitMeaning);

describe("unitMeaning", () => {
  it("glosses the product-level units", () => {
    expect(m("video_minute")).toBe("per minute of finished video");
    expect(m("job_minimum")).toContain("smallest charge");
    expect(m("download_1080p_minute")).toBe("per minute of video, downloaded at 1080p");
    expect(m("download_720p_minute")).toContain("720p");
    expect(m("download_minimum")).toContain("smallest charge");
    expect(m("scene_regenerate")).toContain("scene");
    expect(m("scene_regenerate_clip_kling")).toContain("clip");
    expect(m("repurpose_clip")).toContain("clip");
    expect(m("reply_draft")).toContain("reply");
  });

  it("reads the measure off a model unit, and its priced variant", () => {
    expect(m("model_veo_3_1_second")).toBe("per second");
    expect(m("model_gemini_3_pro_image_image")).toBe("per image");
    expect(m("model_elevenlabs_v4_character")).toBe("per character");
    expect(m("model_gemini_3_6_flash_request")).toBe("per request");
    expect(m("model_wan_2_7_second_720p")).toBe("per second, at 720p");
    expect(m("model_kling_v3_second_audio")).toBe("per second, with sound");
    expect(m("model_seedance_1_5_pro_second_720p_silent")).toBe("per second, at 720p, silent");
    expect(m("model_runway_video_upscale_second_4k")).toBe("per second, at 4k");
    expect(m("model_openai_gpt_image_2_image_high")).toBe("per image, high quality");
  });

  it("uses the LAST measure word: 'image' inside the model id is not the measure", () => {
    expect(m("model_openai_gpt_image_2_image")).toBe("per image");
    expect(m("model_openai_gpt_image_2_5_flare_image_low")).toBe("per image, low quality");
  });

  it("says nothing when the name does not settle it", () => {
    expect(m("something_custom")).toBeNull();
    expect(m("model_foo_minute")).toBeNull();
    expect(m("model_foo_second_weird")).toBeNull();
    expect(m("download_4k_minute")).toBeNull();
    expect(m("")).toBeNull();
  });

  it("covers every unit the editor offers, in all three languages", () => {
    for (const t of [en, ru, uz]) {
      for (const u of [...SPECIAL_UNITS, ...LEDGER_UNITS]) {
        expect(m(u, t), `${u} (${t === en ? "en" : t === ru ? "ru" : "uz"})`).toBeTruthy();
      }
    }
  });

  it("glosses every unit of the owner-apply price files", () => {
    const root = join(__dirname, "..", "..", "docs", "sql");
    const units = ["prices_2026_10_01.sql", "prices_corrections_2026_10_01.sql", "prices_defaults_2026_10_03.sql"].flatMap(
      (f) => [...readFileSync(join(root, f), "utf8").matchAll(/^\s*\('([a-z0-9_]+)',\s*[0-9]/gm)].map((x) => x[1]),
    );
    expect(units.length).toBeGreaterThanOrEqual(60);
    for (const u of units) expect(m(u), u).toBeTruthy();
  });

  it("keeps Uzbek and Russian glosses distinct from the English text", () => {
    expect(m("video_minute", ru)).not.toBe(m("video_minute"));
    expect(m("video_minute", uz)).not.toBe(m("video_minute"));
    expect(m("model_wan_2_7_second_720p", ru)).toBe("за секунду, в 720p");
  });
});

describe("chargePerUnit", () => {
  it("folds the margin in, and leaves a flat floor alone", () => {
    expect(chargePerUnit({ unit: "model_x_image", creditsPerUnit: 4, margin: 1.5 })).toBe(10);
    expect(chargePerUnit({ unit: "job_minimum", creditsPerUnit: 5, margin: 2 })).toBe(5);
    expect(isFlatUnit("download_minimum")).toBe(true);
    expect(isFlatUnit("video_minute")).toBe(false);
  });
});
