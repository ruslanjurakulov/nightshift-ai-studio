/**
 * The run step's pure half (lib/regionEdit/run.ts): the job's params and the reading of a finished job.
 * What would break without these: params the database refuses (a prompt next to regions, a region id it does not accept), a region
 * shown as applied that the worker reported failed, a reason the screen has no sentence for, a charge shown when the job is not
 * settled, a "released" amount that is not held minus charged, and a result opened from a job that did not complete.
 */
import { describe, expect, it } from "vitest";
import type { StudioModel } from "@/lib/creative/studio";
import { REGION_REASONS, RUN_FAILURES, buildRunParams, isFinalPhase, jsonbTextBytes, paramsFit, toRunView } from "@/lib/regionEdit/run";

const SRC = "22222222-2222-4222-8222-222222222222";
const NEW = "33333333-3333-4333-8333-333333333333";
const model = (qualities: StudioModel["qualities"] = []): StudioModel => ({ id: "m", displayName: "M", capabilities: ["edit"], beta: false, qualities });
const region = (over: Record<string, unknown> = {}) => ({ name: "Sky", prompt: "dusk", x: 1, y: 2, w: 30, h: 40, ...over });

describe("buildRunParams", () => {
  it("is the picture, the regions with words (ids r1, r2 ... in order) and the feather - and no prompt of its own", () => {
    const p = buildRunParams(model(), SRC, [region({ name: "A" }), region({ prompt: "" }), region({ name: "C", prompt: "x", x: 5 })], 6);
    expect(p).toEqual({
      source_asset_id: SRC,
      regions: [
        { id: "r1", name: "A", prompt: "dusk", rect: { x: 1, y: 2, w: 30, h: 40 } },
        { id: "r2", name: "C", prompt: "x", rect: { x: 5, y: 2, w: 30, h: 40 } },
      ],
      region_feather: 6,
    });
    expect(Object.keys(p).sort()).toEqual(["region_feather", "regions", "source_asset_id"]);
  });

  it("carries the model's own tier (medium by default) and nothing for a model without tiers", () => {
    expect(buildRunParams(model(["low", "medium", "high"]), SRC, [region()], 4).quality).toBe("medium");
    expect(buildRunParams(model(["low", "high"]), SRC, [region()], 4).quality).toBe("low");
    expect(buildRunParams(model(), SRC, [region()], 4)).not.toHaveProperty("quality");
  });

  it("uses only keys and shapes the database accepts (ids a-z 0-9 _ -, at most 5 regions as sent)", () => {
    const p = buildRunParams(model(), SRC, Array.from({ length: 5 }, (_v, i) => region({ name: `R${i}` })), 4);
    expect(p.regions.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    for (const r of p.regions) expect(r.id).toMatch(/^[a-z0-9][a-z0-9_-]{0,31}$/);
  });
});

const row = (over: Record<string, unknown> = {}) => ({
  id: "j1",
  capability: "edit",
  status: "completed",
  quoted_credits: 9,
  charged_credits: 6,
  error_code: null,
  params: {
    source_asset_id: SRC,
    regions: [
      { id: "r1", name: "Sky", prompt: "x", rect: {} },
      { id: "r2", name: "Road", prompt: "x", rect: {} },
      { id: "r3", name: "Tree", prompt: "x", rect: {} },
    ],
  },
  result: {
    regions: [
      { id: "r1", status: "applied" },
      { id: "r2", status: "refused", code: "policy" },
      { id: "r3", status: "applied" },
    ],
  },
  result_asset_ids: [NEW],
  ...over,
});

describe("toRunView", () => {
  it("reads a partly applied job: each region's status and reason, the charge and what was given back", () => {
    const v = toRunView(row())!;
    expect(v.phase).toBe("completed");
    expect(v.regions.map((r) => [r.name, r.status, r.reason])).toEqual([["Sky", "applied", null], ["Road", "refused", "policy"], ["Tree", "applied", null]]);
    expect([v.held, v.charged, v.released, v.appliedCount, v.resultAssetId, v.sourceAssetId]).toEqual([9, 6, 3, 2, NEW, SRC]);
    expect(v.failure).toBeNull();
  });

  it("reads numbers that arrive as text, and never makes a charge up before the job is settled", () => {
    const v = toRunView(row({ status: "running", quoted_credits: "9.00", charged_credits: null, result: null, result_asset_ids: [] }))!;
    expect(v).toMatchObject({ phase: "running", held: 9, charged: null, released: null, appliedCount: 0, resultAssetId: null });
    expect(v.regions.every((r) => r.status === null)).toBe(true);
    expect(isFinalPhase(v.phase)).toBe(false);
  });

  it("an all-failed job is failed: nothing charged, everything released, and every region says why", () => {
    const v = toRunView(row({
      status: "failed", error_code: "no_region_applied", charged_credits: 0,
      result: { regions: [{ id: "r1", status: "failed", code: "unavailable" }, { id: "r2", status: "refused", code: "region_out_of_bounds" }, { id: "r3", status: "failed", code: "pixel_lock_failed" }] },
      result_asset_ids: [],
    }))!;
    expect(v).toMatchObject({ phase: "failed", charged: 0, released: 9, appliedCount: 0, resultAssetId: null, failure: "no_region_applied" });
    expect(v.regions.map((r) => r.reason)).toEqual(["unavailable", "region_out_of_bounds", "pixel_lock_failed"]);
  });

  it("opens a result only from a completed job", () => {
    expect(toRunView(row({ status: "failed", error_code: "result_not_stored" }))!.resultAssetId).toBeNull();
    expect(toRunView(row({ status: "completed", result_asset_ids: [] }))!.resultAssetId).toBeNull();
  });

  it("a reason outside the closed list reads as a provider error, never as the vendor's text; a code with no sentence reads as other", () => {
    const v = toRunView(row({
      status: "failed", error_code: "something_new", result: { regions: [{ id: "r1", status: "failed", code: "your key sk-123 is bad" }] },
    }))!;
    expect(v.regions[0]).toMatchObject({ status: "failed", reason: "provider_error" });
    expect(v.failure).toBe("other");
  });

  it("maps the job-level codes it has sentences for, and a cancelled job", () => {
    for (const code of RUN_FAILURES.filter((c) => c !== "cancelled")) expect(toRunView(row({ status: "failed", error_code: code }))!.failure).toBe(code);
    expect(toRunView(row({ status: "cancelled", error_code: "cancelled", charged_credits: 0 }))!.failure).toBe("cancelled");
    expect(toRunView(row({ status: "expired", error_code: "not_picked_up", charged_credits: 0 }))).toMatchObject({ phase: "expired", failure: "not_picked_up", released: 9 });
  });

  it("every working status is running; an unknown status is not a region edit's", () => {
    for (const s of ["running", "provider_pending", "processing"]) expect(toRunView(row({ status: s }))!.phase).toBe("running");
    expect(toRunView(row({ status: "queued" }))!.phase).toBe("queued");
    expect(toRunView(row({ status: "teleporting" }))).toBeNull();
  });

  it("is null for anything that is not an edit with regions", () => {
    expect(toRunView(null)).toBeNull();
    expect(toRunView("x")).toBeNull();
    expect(toRunView(row({ capability: "t2i" }))).toBeNull();
    expect(toRunView(row({ params: { prompt: "x", source_asset_id: SRC } }))).toBeNull();
    expect(toRunView({ ...row(), id: 5 })).toBeNull();
  });

  it("a held amount is never negative or invented", () => {
    expect(toRunView(row({ quoted_credits: null }))!.held).toBe(0);
    expect(toRunView(row({ charged_credits: 12 }))!.released).toBe(0);
  });
});

describe("the lists the database and the worker share", () => {
  it("has the 15 reasons and no duplicates", () => {
    expect(REGION_REASONS).toHaveLength(15);
    expect(new Set(REGION_REASONS).size).toBe(15);
  });

  it("the size of params is counted the way the database stores them: UTF-8 bytes of jsonb text (a space after : and ,)", () => {
    expect(jsonbTextBytes({ a: 1, b: [1, 2] })).toBe('{"a": 1, "b": [1, 2]}'.length);
    expect(jsonbTextBytes({ a: "x:y, z" })).toBe('{"a": "x:y, z"}'.length);          // a : or , inside a string is not a separator
    expect(jsonbTextBytes({ a: 'q"u\\o:te,' })).toBe(JSON.stringify({ a: 'q"u\\o:te,' }).length + 1);
    expect(jsonbTextBytes({ a: "ы" })).toBe('{"a": "ы"}'.length + 1);                // Cyrillic is 2 bytes
    expect(jsonbTextBytes({ a: "日" })).toBe('{"a": "日"}'.length + 2);              // CJK is 3 bytes
  });

  it("five regions of 1000 ASCII letters fit; the same in CJK (3 bytes a letter) with long names do not", () => {
    const mk = (word: string, name: string) => buildRunParams(model(), SRC, Array.from({ length: 5 }, (_v, i) => region({ name, prompt: word.repeat(1000), x: i })), 4);
    expect(paramsFit(mk("a", "Sky"))).toBe(true);
    expect(paramsFit(mk("日", "日".repeat(60)))).toBe(false);
  });
});
