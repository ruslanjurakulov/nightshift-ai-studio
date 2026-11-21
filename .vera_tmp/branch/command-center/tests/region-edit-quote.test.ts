/**
 * The region-edit request and its price (lib/regionEdit/request.ts, quote.ts).
 *
 * What would break without these: a quote that adds a region nobody described (a charge for nothing), a total built
 * when one region could not be priced (a guess shown as a price), a model quietly chosen when none was named or the
 * named one is not sellable (CLAUDE.md rule 4), a rectangle outside the picture clamped instead of refused, a
 * region count over five reaching the database, and a price that is not the one quote the database gives for the very
 * params the run will send (so the number shown is the number held). The database is a fake; nothing here calls a
 * provider or spends a credit.
 */
import { describe, expect, it, vi } from "vitest";
import type { CreativeDb } from "@/lib/creative/operations";
import type { StudioModel } from "@/lib/creative/studio";
import { MAX_REGIONS } from "@/lib/regionEdit/geometry";
import { parseRegionRequest, insidePicture, regionsToRun } from "@/lib/regionEdit/request";
import { editModels, pickEditModel, quoteRegions } from "@/lib/regionEdit/quote";
import { buildRunParams } from "@/lib/regionEdit/run";

const ORG = "11111111-1111-4111-8111-111111111111";
const SRC = "22222222-2222-4222-8222-222222222222";
const SIZE = { width: 800, height: 600 };

const model = (over: Partial<StudioModel> = {}): StudioModel => ({
  id: "gemini-3.1-flash-image",
  displayName: "Gemini",
  capabilities: ["t2i", "edit"],
  beta: false,
  qualities: ["low", "medium", "high"],
  ...over,
});
const MODELS: StudioModel[] = [
  model(),
  model({ id: "openai-gpt-image-2", displayName: "OpenAI", qualities: [] }),
  model({ id: "flux-2-pro", displayName: "Flux", capabilities: ["t2i"] }),
];

const region = (over: Record<string, unknown> = {}) => ({ name: "Sky", prompt: "dusk", x: 10, y: 10, w: 100, h: 80, ...over });
const body = (over: Record<string, unknown> = {}) => ({ org_id: ORG, source_asset_id: SRC, model: "gemini-3.1-flash-image", regions: [region()], ...over });

function fakeDb(prices: (call: number, args: Record<string, unknown>) => { data?: unknown; error?: { code?: string; message?: string; details?: string } }) {
  const calls: Record<string, unknown>[] = [];
  const db: CreativeDb = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, ...args });
      const r = prices(calls.length - 1, args);
      return { data: r.data ?? null, error: r.error ?? null };
    }),
    readJob: async () => ({ data: null, error: null }),
    listJobs: async () => ({ data: [], error: null }),
  };
  return { db, calls };
}
const parsed = (b: unknown) => {
  const p = parseRegionRequest(b, null);
  if (!p.ok) throw new Error(p.error);
  return p.request;
};

describe("parseRegionRequest", () => {
  it("accepts one to five regions", () => {
    for (const n of [1, 2, 5]) expect(parseRegionRequest(body({ regions: Array.from({ length: n }, () => region()) }), null).ok).toBe(true);
  });

  it.each([
    ["no regions", body({ regions: [] }), "no_regions"],
    ["regions missing", { ...body(), regions: undefined }, "no_regions"],
    ["six regions", body({ regions: Array.from({ length: MAX_REGIONS + 1 }, () => region()) }), "too_many_regions"],
    ["a fractional position", body({ regions: [region({ x: 1.5 })] }), "region_invalid"],
    ["a text size", body({ regions: [region({ w: "100" })] }), "region_invalid"],
    ["a region smaller than 16 px", body({ regions: [region({ w: 15 })] }), "region_too_small"],
    ["no model named (there is no default)", body({ model: "" }), "model_required"],
    ["a model id with odd characters", body({ model: "x; drop" }), "model_not_sellable"],
    ["a feather out of range", body({ feather: 9 }), "feather_invalid"],
    ["a feather that is not a whole number", body({ feather: 3.5 }), "feather_invalid"],
    ["a source that is not an id", body({ source_asset_id: "../../etc" }), "source_unavailable"],
    ["an unknown field (never silently dropped)", body({ surprise: 1 }), "invalid_body"],
    ["no organization", { ...body(), org_id: "nope" }, "org_required"],
    ["not an object", [], "invalid_body"],
  ])("refuses %s", (_name, b, error) => {
    const p = parseRegionRequest(b, null);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toBe(error);
  });

  it("takes the open organization when none is sent, and cleans names and words", () => {
    const p = parseRegionRequest({ ...body({ regions: [region({ name: " a\nb ", prompt: "x\ty" })] }), org_id: undefined }, ORG);
    expect(p.ok && p.request.orgId).toBe(ORG);
    expect(p.ok && p.request.regions[0]).toMatchObject({ name: "a b", prompt: "x y" });
    expect(p.ok && p.request.feather).toBe(4);
  });

  it("checks rectangles against the recorded picture size, refusing instead of clamping", () => {
    expect(insidePicture([region({ x: 700, w: 100 })].map((r) => r as never), SIZE)).toBe(true);
    expect(insidePicture([region({ x: 701, w: 100 })].map((r) => r as never), SIZE)).toBe(false);
    expect(insidePicture([region({ y: 521, h: 80 })].map((r) => r as never), SIZE)).toBe(false);
    expect(insidePicture([region({ x: -1 })].map((r) => r as never), SIZE)).toBe(false);
  });
});

describe("which model", () => {
  it("offers only models that can edit pictures", () => {
    expect(editModels(MODELS).map((m) => m.id)).toEqual(["gemini-3.1-flash-image", "openai-gpt-image-2"]);
  });

  it("never picks for the person: none named, unknown, or unable to edit is a refusal", () => {
    expect(pickEditModel(MODELS, "")).toEqual({ ok: false, error: "model_required" });
    expect(pickEditModel(MODELS, "no-such-model")).toEqual({ ok: false, error: "model_not_sellable" });
    expect(pickEditModel(MODELS, "flux-2-pro")).toEqual({ ok: false, error: "model_not_sellable" });
    expect(pickEditModel(MODELS, "openai-gpt-image-2")).toMatchObject({ ok: true });
  });

  it("asks the model's own tier, and none for a model without tiers", () => {
    const regions = [{ name: "Sky", prompt: "dusk", x: 10, y: 10, w: 100, h: 80 }];
    expect(buildRunParams(MODELS[0], SRC, regions, 4)).toEqual({
      source_asset_id: SRC,
      quality: "medium",
      regions: [{ id: "r1", name: "Sky", prompt: "dusk", rect: { x: 10, y: 10, w: 100, h: 80 } }],
      region_feather: 4,
    });
    expect(buildRunParams(MODELS[1], SRC, regions, 6)).not.toHaveProperty("quality");
    expect(buildRunParams(MODELS[1], SRC, regions, 6)).toHaveProperty("region_feather", 6);
  });
});

describe("quoteRegions", () => {
  const priced = (n: number) => ({ data: { credits: n } });
  const regions3 = [region({ name: "A", prompt: "one" }), region({ name: "B", prompt: "two" }), region({ name: "C", prompt: "three" })];

  it("is ONE database quote of the params the run will send: the picture, the tier and every region with words", async () => {
    const { db, calls } = fakeDb(() => priced(9));
    const out = await quoteRegions(db, parsed(body({ regions: regions3 })), MODELS, SIZE);
    expect(out.status).toBe(200);
    expect(out.body.quote).toMatchObject({ total: 9, count: 3, model: "gemini-3.1-flash-image", skipped: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ fn: "quote_creative_job", p_capability: "edit", p_model: "gemini-3.1-flash-image", p_org: ORG });
    const sent = calls[0].p_params as { source_asset_id: string; quality: string; region_feather: number; regions: { id: string; name: string; prompt: string; rect: unknown }[] };
    expect(sent.source_asset_id).toBe(SRC);
    expect(sent.quality).toBe("medium");
    expect(sent.region_feather).toBe(4);
    expect(sent.regions.map((r) => [r.id, r.name, r.prompt])).toEqual([["r1", "A", "one"], ["r2", "B", "two"], ["r3", "C", "three"]]);
    expect(sent).not.toHaveProperty("prompt");
  });

  it("asks for exactly the params the run route sends, so the price shown is the price held", async () => {
    const { db, calls } = fakeDb(() => priced(9));
    const req = parsed(body({ regions: regions3, feather: 6 }));
    await quoteRegions(db, req, MODELS, SIZE);
    expect(calls[0].p_params).toEqual(buildRunParams(MODELS[0], SRC, req.regions, 6));
  });

  it("does not price or charge a region without words, and says which it skipped", async () => {
    const { db, calls } = fakeDb(() => priced(6));
    const req = parsed(body({ regions: [region({ prompt: "x" }), region({ prompt: "  " }), region({ prompt: "y" })] }));
    const out = await quoteRegions(db, req, MODELS, SIZE);
    expect(calls).toHaveLength(1);
    expect((calls[0].p_params as { regions: unknown[] }).regions).toHaveLength(2);
    expect(out.body.quote).toMatchObject({ total: 6, count: 2, skipped: [1] });
  });

  it("refuses when no region has words, before asking the database anything", async () => {
    const { db, calls } = fakeDb(() => priced(3));
    const out = await quoteRegions(db, parsed(body({ regions: [region({ prompt: "" }), region({ prompt: " " })] })), MODELS, SIZE);
    expect(out).toMatchObject({ status: 422, body: { error: "no_prompt" } });
    expect(calls).toEqual([]);
  });

  it("refuses an unknown or non-editing model, before asking the database anything", async () => {
    for (const m of ["no-such-model", "flux-2-pro"]) {
      const { db, calls } = fakeDb(() => priced(3));
      const out = await quoteRegions(db, parsed(body({ model: m })), MODELS, SIZE);
      expect(out).toMatchObject({ status: 422, body: { error: "model_not_sellable" } });
      expect(calls).toEqual([]);
    }
  });

  it("refuses a rectangle outside the picture, before asking the database anything", async () => {
    const { db, calls } = fakeDb(() => priced(3));
    const out = await quoteRegions(db, parsed(body({ regions: [region({ x: 790 })] })), MODELS, SIZE);
    expect(out).toMatchObject({ status: 422, body: { error: "region_out_of_bounds" } });
    expect(calls).toEqual([]);
  });

  it("gives no total when the database cannot price it, and passes its reason on", async () => {
    const { db } = fakeDb(() => ({ error: { code: "NS400", message: "unpriced" } }));
    const out = await quoteRegions(db, parsed(body({ regions: [region(), region(), region()] })), MODELS, SIZE);
    expect(out.status).toBe(422);
    expect(out.body).toMatchObject({ error: "unpriced" });
    expect(out.body.quote).toBeUndefined();
  });

  it("does not turn a malformed or negative database answer into a number", async () => {
    for (const bad of [{ data: { credits: "3" } }, { data: { credits: -1 } }, { data: {} }, { data: { credits: NaN } }]) {
      const { db } = fakeDb(() => bad);
      const out = await quoteRegions(db, parsed(body()), MODELS, SIZE);
      expect(out.status).toBeGreaterThanOrEqual(400);
      expect(out.body.quote).toBeUndefined();
    }
  });

  it("shows no per-region number: the quote says only the total (the database's rounding is not re-derived here)", async () => {
    const { db } = fakeDb(() => priced(9));
    const out = await quoteRegions(db, parsed(body({ regions: regions3 })), MODELS, SIZE);
    expect(out.body.quote).not.toHaveProperty("perRegion");
    expect(out.body.quote).not.toHaveProperty("lines");
  });

  it("refuses words too long for the database's 16 KB of params, before asking it anything", async () => {
    const { db, calls } = fakeDb(() => priced(9));
    // 5 regions x 1000 CJK characters = 3 bytes each: 15 KB of words plus names and rectangles is over 16 KB
    const long = "日".repeat(1000);
    const out = await quoteRegions(db, parsed(body({ regions: Array.from({ length: 5 }, (_v, i) => region({ name: "日".repeat(60), prompt: long, x: 10 + i })) })), MODELS, SIZE);
    expect(out).toMatchObject({ status: 422, body: { error: "params_too_large" } });
    expect(calls).toEqual([]);
  });

  it("regionsToRun lists the positions that have words", () => {
    expect(regionsToRun([region({ prompt: "" }), region({ prompt: "a" })].map((r) => r as never)).map((x) => x.index)).toEqual([1]);
  });
});
