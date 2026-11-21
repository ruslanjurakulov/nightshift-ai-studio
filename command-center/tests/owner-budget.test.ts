/**
 * The owner's budget calculator (lib/owner/budget.ts) against the real registry file.
 *
 * What would break without these: a model with no vendor price shown as "0" or "infinitely many" (CLAUDE.md #5), a count
 * rounded UP (the owner would plan on videos the money does not buy), a price taken from the wrong variant (the 4k row
 * instead of the default), a billing floor ignored, a comma decimal read as nothing, floating-point dust turning
 * 250 000 characters into 249 999, and a new pricing shape in the registry that the calculator silently mis-reads.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chargedPrices, parsePrices } from "../lib/credits";
import {
  BASE,
  BUDGET_KINDS,
  budgetModelOf,
  budgetModelsFrom,
  computeBudget,
  computeForModel,
  decimalOf,
  floorSecondsOf,
  parseBudget,
  type BudgetModel,
  type BudgetResult,
} from "../lib/owner/budget";

type Entry = Record<string, unknown> & { id: string; output: string; pricing: Record<string, unknown> };
const REGISTRY = JSON.parse(readFileSync(join(__dirname, "..", "..", "schemas", "model_registry.json"), "utf8")) as { models: Entry[] };
const COLUMNS = ["id", "display_name", "provider", "adapter", "capabilities", "credit_unit", "entitlement"];
const TODAY = "2026-11-11";

/** A registry entry as model_registry_admin() returns it: the columns, the rest as spec (modules/model_registry.py sync_rows). */
function rowOf(e: Entry, availability = "hidden"): Record<string, unknown> {
  const spec: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) if (!COLUMNS.includes(k)) spec[k] = v;
  return { id: e.id, display_name: e.display_name, provider: e.provider, capabilities: e.capabilities, credit_unit: e.credit_unit, entitlement: e.entitlement, availability, spec };
}
const entry = (id: string): Entry => {
  const e = REGISTRY.models.find((m) => m.id === id);
  if (!e) throw new Error(`registry has no ${id}`);
  return e;
};
const model = (id: string, charged: Record<string, number> | null = null, today = TODAY): BudgetModel => {
  const m = budgetModelOf(rowOf(entry(id)), charged, today);
  if (!m) throw new Error(`${id} did not build`);
  return m;
};

/** Every number anywhere in a result. */
function numbersIn(r: BudgetResult): number[] {
  const out: number[] = [];
  for (const v of Object.values(r)) {
    if (typeof v === "number") out.push(v);
    else if (v && typeof v === "object") for (const x of Object.values(v)) if (typeof x === "number") out.push(x);
  }
  return out;
}

describe("a typed amount", () => {
  it("reads dollars, with a dot or a comma, and nothing else", () => {
    expect(parseBudget("10")).toBe(10);
    expect(parseBudget(" 10 ")).toBe(10);
    expect(parseBudget("10.5")).toBe(10.5);
    expect(parseBudget("10,5")).toBe(10.5);
    expect(parseBudget("$10")).toBe(10);
    expect(parseBudget("0.01")).toBe(0.01);
    expect(parseBudget("10,50")).toBe(10.5);
    expect(parseBudget("1000")).toBe(1000);
    expect(parseBudget("1000000000")).toBe(1e9);
    expect(parseBudget(25)).toBe(25);
  });

  it("refuses a comma followed by exactly three digits: '1,000' is a thousand to one reader and one dollar to another", () => {
    for (const ambiguous of ["1,000", "10,500", "1,000,000", "999,999", "$1,000"]) expect(parseBudget(ambiguous), ambiguous).toBeNull();
    expect(parseBudget("1,0")).toBe(1);
    expect(parseBudget("1,0000")).toBe(1);
    expect(parseBudget("1.000")).toBe(1);
  });

  it("is nothing when it is not an amount", () => {
    for (const bad of ["", " ", "abc", "-1", "0", "0.0", "1e3", "10.5.5", "10,5,5", "1 000", "Infinity", "NaN", "1000000001", "1000000000.000001", "1.1234567", "10$", "+10", "0x10", ".5"]) {
      expect(parseBudget(bad), JSON.stringify(bad)).toBeNull();
    }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0, null, undefined, {}, [], true]) expect(parseBudget(bad), String(bad)).toBeNull();
  });

  it("nothing typed shows nothing; something that is not an amount says so; whatever the price", () => {
    for (const blank of ["", "   ", null, undefined]) {
      expect(computeBudget({ budget: blank, kind: "image", unit: "image", usdPerUnit: 0.04 })).toEqual({ kind: "empty" });
      expect(computeBudget({ budget: blank, kind: "image", unit: "image", usdPerUnit: null })).toEqual({ kind: "empty" });
    }
    for (const bad of ["abc", "-3", "0", "1,000"]) {
      expect(computeBudget({ budget: bad, kind: "image", unit: "image", usdPerUnit: 0.04 })).toEqual({ kind: "invalid" });
      expect(computeBudget({ budget: bad, kind: "image", unit: "image", usdPerUnit: null })).toEqual({ kind: "invalid" });
    }
  });
});

describe("exact arithmetic", () => {
  it("rescales the price when the budget has more decimals than the price (review gap 1)", () => {
    // 10.123456 / 0.04 = 253.0864 -> 253; a price left at its own scale would read 2,530,864.
    expect(computeBudget({ budget: "10.123456", kind: "image", unit: "image", usdPerUnit: 0.04 })).toEqual({ kind: "images", count: 253 });
    expect(computeBudget({ budget: "0.000001", kind: "image", unit: "image", usdPerUnit: 0.0000004 })).toEqual({ kind: "images", count: 2 });
  });

  it("a count beyond exact JavaScript integers is not shown as a number (review gap 2)", () => {
    // $1B at $0.0000001 = 1e16 > Number.MAX_SAFE_INTEGER: never a rounded, wrong count.
    expect(computeBudget({ budget: "1000000000", kind: "image", unit: "image", usdPerUnit: 0.0000001 })).toEqual({ kind: "no_price" });
  });

  it("reads a registry price as the decimal it was written as", () => {
    expect(decimalOf(0.036667)).toEqual({ num: 36667n, scale: 6 });
    expect(decimalOf(4e-5)).toEqual({ num: 4n, scale: 5 });
    expect(decimalOf(1e-7)).toEqual({ num: 1n, scale: 7 });
    expect(decimalOf(1e21)).toEqual({ num: 10n ** 21n, scale: 0 });
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) expect(decimalOf(bad)).toBeNull();
  });

  it("is exact where floating point is not, and never rounds up", () => {
    // $10 / $0.00004 is 249999.99999999997 in binary arithmetic and exactly 250 000 on paper.
    expect(10 / 0.00004).toBeLessThan(250000);
    expect(computeBudget({ budget: "10", kind: "audio", unit: "character", usdPerUnit: 0.00004 })).toEqual({ kind: "characters", count: 250000 });
    expect(computeBudget({ budget: "0.6", kind: "image", unit: "image", usdPerUnit: 0.2 })).toEqual({ kind: "images", count: 3 });
    // The cases a floating-point tolerance once rounded UP: each must be the exact floor.
    expect(computeForModel(model("elevenlabs-flash-v2.5"), "40300")).toEqual({ kind: "characters", count: 1_007_500_000 });
    expect(computeForModel(model("recraft-v4.1-flash"), "1000000")).toEqual({ kind: "images", count: 142_857_142 });
    // $13 201 / the registry's per-second price = 360 023.9... s = 6000.39... min: 6000.3, not 6000.4.
    expect(computeForModel(model("elevenlabs-dubbing-v2"), "13201")).toEqual({ kind: "seconds", minutes: 6000.3, clips: null, floorSeconds: null });
    expect(computeBudget({ budget: "1000000000", kind: "video", unit: "second", usdPerUnit: 0.1, durationS: 5 })).toEqual({
      kind: "videos",
      count: 2_000_000_000,
      durationS: 5,
      billedS: 5,
      minutes: 166_666_666.6,
    });
    expect(computeBudget({ budget: "1000000000", kind: "image", unit: "image", usdPerUnit: 0.5 })).toEqual({ kind: "images", count: 2_000_000_000 });
  });

  it("minutes keep one decimal, rounded down", () => {
    expect(computeBudget({ budget: "2.48", kind: "audio", unit: "second", usdPerUnit: 0.01 })).toMatchObject({ minutes: 4.1 });
    expect(computeBudget({ budget: "0.59", kind: "audio", unit: "second", usdPerUnit: 0.01 })).toMatchObject({ minutes: 0.9 });
    expect(computeBudget({ budget: "0.6", kind: "audio", unit: "second", usdPerUnit: 0.01 })).toMatchObject({ minutes: 1 });
    expect(computeBudget({ budget: "0.05", kind: "audio", unit: "second", usdPerUnit: 0.01 })).toMatchObject({ minutes: 0 });
  });
});

describe("a price that is not a price", () => {
  it("zero, negative, missing or not a number is 'no price', never a count", () => {
    for (const p of [0, -0.1, null, undefined, Number.NaN, Number.POSITIVE_INFINITY, "0.04"]) {
      expect(computeBudget({ budget: "10", kind: "image", unit: "image", usdPerUnit: p }), String(p)).toEqual({ kind: "no_price" });
    }
    expect(computeBudget({ budget: "10", kind: "video", unit: null, usdPerUnit: 0.1 })).toEqual({ kind: "no_price" });
  });

  it("a price so small the count overflows is 'no price', never Infinity", () => {
    expect(computeBudget({ budget: "1000000", kind: "image", unit: "image", usdPerUnit: 1e-320 })).toEqual({ kind: "no_price" });
  });
});

describe("each pricing shape the registry uses", () => {
  it("per image, flat: the base price", () => {
    const m = model("recraft-v4.1");
    expect(m.options).toEqual([{ key: BASE, usd: 0.035, customerCredits: null }]);
    expect(m.defaultWhy).toBe("base");
    expect(computeForModel(m, "10")).toEqual({ kind: "images", count: 285 });
  });

  it("per image, by image size: the size that IS the base price", () => {
    const m = model("gemini-3.1-flash-image");
    expect(m.variantsBy).toBe("image_size");
    expect(m.defaultOption).toBe("1K");
    expect(m.options.map((o) => o.key)).toEqual(["512", "1K", "2K", "4K"]);
    expect(computeForModel(m, "10")).toEqual({ kind: "images", count: 149 });
    expect(computeForModel(m, "10", "4K")).toEqual({ kind: "images", count: 66 });
  });

  it("per image, by quality, with every quality unpriced: no price at all", () => {
    const m = model("openai-gpt-image-2");
    expect(m.options).toEqual([]);
    expect(m.unpricedVariants).toEqual(["low", "medium", "high"]);
    expect(computeForModel(m, "10")).toEqual({ kind: "no_price" });
  });

  it("per image, by quality, with one quality priced: the unpriced one is never an option", () => {
    const m = model("grok-imagine-image-2.0");
    expect(m.options.map((o) => o.key)).toEqual(["low"]);
    expect(m.unpricedVariants).toEqual(["medium"]);
    expect(computeForModel(m, "10")).toEqual({ kind: "images", count: 250 });
  });

  it("per second of video, by resolution with a default: the default resolution and the shortest length", () => {
    const m = model("minimax-h3-lite");
    expect(m.defaultOption).toBe("768p");
    expect(m.defaultWhy).toBe("default_resolution");
    expect(m.durations[0]).toBe(4);
    // $10 / (4 s × the registry's per-second price) = 62.5 videos -> 62, 248 s -> 4.1 min.
    expect(computeForModel(m, "10")).toEqual({ kind: "videos", count: 62, durationS: 4, billedS: 4, minutes: 4.1 });
    expect(computeForModel(m, "10", "480p", 10)).toEqual({ kind: "videos", count: 40, durationS: 10, billedS: 10, minutes: 6.6 });
  });

  it("per second of video, by resolution with no default: the base price, named after the variants it equals", () => {
    const veo = model("veo-3.1");
    expect(veo.defaultOption).toBe(BASE);
    expect(veo.baseMatches).toEqual(["720p", "1080p"]);
    expect(veo.options.map((o) => o.key)).toEqual([BASE, "720p", "1080p", "4k"]);
    expect(computeForModel(veo, "10")).toEqual({ kind: "videos", count: 6, durationS: 4, billedS: 4, minutes: 0.4 });
    const fast = model("veo-3.1-fast");
    expect(fast.defaultOption).toBe("720p");
    expect(fast.options.some((o) => o.key === BASE)).toBe(false);
  });

  it("per second of video, by sound: the silent row that is the base price", () => {
    const m = model("kling-v3");
    expect(m.defaultOption).toBe("silent");
    expect(computeForModel(m, "10")).toEqual({ kind: "videos", count: 23, durationS: 5, billedS: 5, minutes: 1.9 });
    expect(computeForModel(m, "10", "audio")).toEqual({ kind: "videos", count: 15, durationS: 5, billedS: 5, minutes: 1.2 });
  });

  it("per second of video, by resolution and sound: the priced pair that is the base price, the unpriced pairs listed", () => {
    const m = model("seedance-1.5-pro");
    expect(m.defaultOption).toBe("720p_silent");
    expect(m.unpricedVariants).toEqual(["480p_silent", "480p_audio", "1080p_silent"]);
    expect(computeForModel(m, "10")).toEqual({ kind: "videos", count: 76, durationS: 5, billedS: 5, minutes: 6.3 });
  });

  it("per second of a source video, by upscale size, with no base price: the cheapest priced size", () => {
    const m = model("runway-video-upscale");
    expect(m.defaultOption).toBe("720p");
    expect(m.defaultWhy).toBe("cheapest_variant");
    expect(m.durations).toEqual([]);
    // No set length: minutes of video only. $10 / the cheapest variant's per-second price = 23.8 s -> 0.3 min.
    expect(computeForModel(m, "10")).toEqual({ kind: "seconds", minutes: 0.3, clips: null, floorSeconds: null });
  });

  it("per second of video with no set lengths: minutes only", () => {
    // $10 / the HD per-second price (BFL pricing, read 2026-11-11; in the registry) = 66.6 s -> 1.1 min.
    expect(computeForModel(model("flux-3-video"), "10")).toEqual({ kind: "seconds", minutes: 1.1, clips: null, floorSeconds: null });
  });

  it("a video model with no price in the registry", () => {
    const m = model("minimax-hailuo-2.3"); // billed per clip by MiniMax: no single per-second price in the registry
    expect(m.options).toEqual([]);
    expect(computeForModel(m, "10")).toEqual({ kind: "no_price" });
  });

  it("per character of speech: characters, and no minutes (the registry gives no speaking rate)", () => {
    const r = computeForModel(model("elevenlabs-flash-v2.5"), "10");
    expect(r).toEqual({ kind: "characters", count: 250000 });
    expect(Object.keys(r)).not.toContain("minutes");
  });

  it("per second of audio with set lengths and a billing floor: minutes, tracks of the shortest length, the floor", () => {
    const m = model("sonilo-music");
    expect(m.floorSeconds).toBe(10);
    expect(computeForModel(m, "10")).toEqual({
      kind: "seconds",
      minutes: 74,
      clips: { count: 444, durationS: 10, billedS: 10 },
      floorSeconds: 10,
    });
  });

  it("per second of audio with no set length but a floor: minutes, and the floor said", () => {
    const m = model("sonilo-video-music");
    expect(m.floorSeconds).toBe(10);
    expect(computeForModel(m, "10")).toEqual({ kind: "seconds", minutes: 18.5, clips: null, floorSeconds: 10 });
  });

  it("per second of audio with no floor stated: none is assumed", () => {
    const m = model("elevenlabs-dubbing-v2");
    expect(m.floorSeconds).toBeNull();
    expect(computeForModel(m, "10")).toEqual({ kind: "seconds", minutes: 4.5, clips: null, floorSeconds: null });
  });

  it("per request: a count, when there is a price (the registry's one per-request model has none)", () => {
    expect(computeForModel(model("gemini-3.6-flash"), "10")).toEqual({ kind: "no_price" });
    expect(computeBudget({ budget: "1", kind: "other", unit: "request", usdPerUnit: 0.003 })).toEqual({ kind: "requests", count: 333 });
  });
});

describe("a billing floor", () => {
  it("bills a job shorter than the floor as the floor", () => {
    // 5 s clips billed 10 s each at $0.10/s: $10 buys 10 of them, not 20.
    expect(computeBudget({ budget: "10", kind: "video", unit: "second", usdPerUnit: 0.1, durationS: 5, floorSeconds: 10 })).toEqual({
      kind: "videos",
      count: 10,
      durationS: 5,
      billedS: 10,
      minutes: 0.8,
    });
    expect(computeBudget({ budget: "10", kind: "audio", unit: "second", usdPerUnit: 0.1, durationS: 5, floorSeconds: 10 })).toMatchObject({
      clips: { count: 10, durationS: 5, billedS: 10 },
    });
  });

  it("is read only from the registry's own words, and only for per-second prices", () => {
    expect(floorSecondsOf({ pricing: { unit: "second", note: "llms-full.txt: a 10-second billing floor." } })).toBe(10);
    expect(floorSecondsOf({ pricing: { unit: "second" }, api_documented: { note: "10-120 s offered (10 s billing floor; ...)" } })).toBe(10);
    expect(floorSecondsOf({ pricing: { unit: "image", note: "a 10-second billing floor" } })).toBeNull();
    expect(floorSecondsOf({ pricing: { unit: "second", note: "minimum 10 credits per task" } })).toBeNull();
    expect(floorSecondsOf(null)).toBeNull();
  });
});

describe("status", () => {
  it("names a vendor shutdown, and whether it has passed", () => {
    expect(model("veo-3.1").pastShutdown).toBe(true);
    expect(model("veo-3.1").shutdownOn).toBe("2026-10-22");
    expect(model("veo-3.1", null, "2026-10-01").pastShutdown).toBe(false);
    expect(model("recraft-v4.1").shutdownOn).toBeNull();
  });

  it("carries the sale state, the terms gate and the estimate mark", () => {
    const row = budgetModelOf(rowOf(entry("sonilo-music"), "beta"), null, TODAY)!;
    expect(row.availability).toBe("beta");
    expect(row.termsGate).toBe(true);
    expect(model("ideogram-3").termsGate).toBe(false);
    expect(row.estimate).toBe(true);
    expect(budgetModelOf({ ...rowOf(entry("recraft-v4.1")), availability: "nonsense" }, null, TODAY)!.availability).toBeNull();
    const confirmed = rowOf(entry("recraft-v4.1"));
    (confirmed.spec as { pricing: Record<string, unknown> }).pricing = { ...entry("recraft-v4.1").pricing, confirmed: true };
    expect(budgetModelOf(confirmed, null, TODAY)!.estimate).toBe(false);
  });
});

describe("the customer's price", () => {
  const list = chargedPrices(
    parsePrices([
      { unit: "model_recraft_v4_1_image", credits_per_unit: 5, margin: 0.2 },
      { unit: "model_minimax_h3_lite_second_768p", credits_per_unit: 10, margin: 0 },
      { unit: "model_minimax_h3_lite_second", credits_per_unit: 99, margin: 0 },
      { unit: "model_seedance_1_5_pro_second_720p_silent", credits_per_unit: 4, margin: 0.5 },
      { unit: "model_kling_v3_second_audio", credits_per_unit: 20, margin: 0 },
      { unit: "model_veo_3_1_second", credits_per_unit: 50, margin: 0 },
    ]),
  );
  const charged = Object.fromEntries(Object.values(list).map((p) => [p.unit, p.creditsPerUnit]));
  const rate = (m: BudgetModel, key: string) => m.options.find((o) => o.key === key)?.customerCredits;

  it("is the charged rate (markup folded in) of the row the quote reads", () => {
    expect(rate(model("recraft-v4.1", charged), BASE)).toBe(6);
    // A default-resolution model is charged per resolution row, never the base row.
    expect(rate(model("minimax-h3-lite", charged), "768p")).toBe(10);
    expect(rate(model("minimax-h3-lite", charged), "480p")).toBeNull();
    expect(rate(model("seedance-1.5-pro", charged), "720p_silent")).toBe(6);
    expect(rate(model("kling-v3", charged), "audio")).toBe(20);
    expect(rate(model("kling-v3", charged), "silent")).toBeNull();
    // A resolution-priced model with no default resolution is charged one flat row for every option.
    expect(rate(model("veo-3.1", charged), BASE)).toBe(50);
    expect(rate(model("veo-3.1", charged), "4k")).toBe(50);
  });

  it("is unknown, not missing, when the list could not be read", () => {
    const m = model("recraft-v4.1", null);
    expect(m.customerUnread).toBe(true);
    expect(rate(m, BASE)).toBeNull();
    expect(model("recraft-v4.1", {}).customerUnread).toBe(false);
  });
});

describe("every model in the registry", () => {
  const rows = REGISTRY.models.map((e) => rowOf(e));
  const groups = budgetModelsFrom(rows, {}, TODAY);
  const all = BUDGET_KINDS.flatMap((k) => groups[k]);

  it("is listed once, in the group of what it makes", () => {
    expect(all).toHaveLength(REGISTRY.models.length);
    expect(new Set(all.map((m) => m.id)).size).toBe(REGISTRY.models.length);
    for (const m of all) {
      const out = entry(m.id).output;
      expect(m.kind, m.id).toBe(out === "text" ? "other" : out);
    }
  });

  it("uses only the pricing shapes these tests cover (a new one needs its own test first)", () => {
    const units = new Set(REGISTRY.models.map((e) => e.pricing.unit));
    const bys = new Set(REGISTRY.models.flatMap((e) => (e.pricing.variants ? [(e.pricing.variants as { by: string }).by] : [])));
    expect([...units].every((u) => ["image", "second", "character", "request"].includes(String(u))), [...units].join()).toBe(true);
    expect([...bys].every((b) => ["resolution", "image_size", "quality", "audio", "resolution_audio", "upscale_target"].includes(b)), [...bys].join()).toBe(true);
  });

  it("answers $10 with a finite count or an explicit 'no price', for every option and every length", () => {
    for (const m of all) {
      const r = computeForModel(m, "10");
      expect(["videos", "seconds", "images", "characters", "requests", "no_price"], m.id).toContain(r.kind);
      for (const n of numbersIn(r)) {
        expect(Number.isFinite(n), `${m.id}: ${JSON.stringify(r)}`).toBe(true);
        expect(n, m.id).toBeGreaterThanOrEqual(0);
      }
      // No priced option: always "no price", never a number.
      if (m.options.length === 0) expect(r, m.id).toEqual({ kind: "no_price" });
      else expect(r.kind, m.id).not.toBe("no_price");
      for (const o of m.options) {
        expect(o.usd > 0 && Number.isFinite(o.usd), `${m.id} ${o.key}`).toBe(true);
        for (const d of m.durations.length ? m.durations : [null]) {
          const x = computeForModel(m, "10", o.key, d);
          expect(x.kind, `${m.id} ${o.key} ${d}`).not.toBe("no_price");
          for (const n of numbersIn(x)) expect(Number.isFinite(n), `${m.id} ${o.key} ${d}`).toBe(true);
        }
      }
      expect(computeForModel(m, ""), m.id).toEqual({ kind: "empty" });
      for (const bad of ["abc", "-1", "1,000"]) expect(computeForModel(m, bad), `${m.id} ${bad}`).toEqual({ kind: "invalid" });
    }
  });

  it("never offers a price the registry does not state", () => {
    for (const m of all) {
      const p = entry(m.id).pricing as { provider_usd_per_unit: number | null; variants?: { prices: Record<string, number | null> } };
      for (const o of m.options) {
        const stated = o.key === BASE ? p.provider_usd_per_unit : p.variants?.prices[o.key];
        expect(o.usd, `${m.id} ${o.key}`).toBe(stated);
      }
      expect(m.defaultOption === null, m.id).toBe(m.options.length === 0);
      if (m.defaultOption !== null) expect(m.options.some((o) => o.key === m.defaultOption), m.id).toBe(true);
    }
  });

  it("drops what is not a model row", () => {
    expect(budgetModelsFrom(null, null, TODAY)).toEqual({ video: [], image: [], audio: [], other: [] });
    expect(budgetModelOf({ id: "BAD ID", provider: "x" }, null, TODAY)).toBeNull();
    expect(budgetModelOf({ id: "ok-id" }, null, TODAY)).toBeNull();
    expect(budgetModelOf("nope", null, TODAY)).toBeNull();
    // A row with no spec at all is a model with no price, not a crash.
    expect(budgetModelOf({ id: "ok-id", provider: "x" }, null, TODAY)).toMatchObject({ options: [], kind: "other", unit: null });
  });
});

describe("every priced option against exact fraction arithmetic", () => {
  // An independent oracle: registry prices have at most nine decimals (Scribe's per-second price has seven), so in nano-dollars they are integers, and every
  // count is one integer division. The calculator must agree at every amount, small and very large.
  const AMOUNTS = [10, 13201, 40300, 1_000_000, 1_000_000_000];
  const nano = (usd: number): bigint => {
    const v = BigInt(Math.round(usd * 1e9));
    expect(Number(v) / 1e9, `price ${usd} has more than nine decimals`).toBe(usd);
    return v;
  };
  const all = BUDGET_KINDS.flatMap((k) => budgetModelsFrom(REGISTRY.models.map((e) => rowOf(e)), null, TODAY)[k]);

  it("agrees for every model, option, length and amount", () => {
    let checked = 0;
    for (const m of all) {
      for (const o of m.options) {
        const p = nano(o.usd);
        for (const d of m.durations.length ? m.durations : [null]) {
          for (const amount of AMOUNTS) {
            const a = BigInt(amount) * 1_000_000_000n;
            const got = computeForModel(m, String(amount), o.key, d);
            const where = `${m.id} ${o.key} ${d} $${amount}`;
            if (m.unit === "second") {
              const billed = d === null ? null : BigInt(Math.max(d, m.floorSeconds ?? 0));
              if (m.kind === "video" && d !== null && billed !== null) {
                const count = a / (p * billed);
                expect(got, where).toEqual({ kind: "videos", count: Number(count), durationS: d, billedS: Number(billed), minutes: Number((count * BigInt(d)) / 6n) / 10 });
              } else {
                expect(got, where).toEqual({
                  kind: "seconds",
                  minutes: Number(a / (p * 6n)) / 10,
                  clips: d === null || billed === null ? null : { count: Number(a / (p * billed)), durationS: d, billedS: Number(billed) },
                  floorSeconds: m.floorSeconds,
                });
              }
            } else {
              const kind = m.unit === "image" ? "images" : m.unit === "character" ? "characters" : "requests";
              expect(got, where).toEqual({ kind, count: Number(a / p) });
            }
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});
