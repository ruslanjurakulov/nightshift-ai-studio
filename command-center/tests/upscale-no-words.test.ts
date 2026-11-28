/**
 * Rule 6 for picture upscale: its one model (Ideogram's Topaz Standard V2) takes no prompt, and its adapter refuses a job that
 * carries one rather than drop the words. Before this the Studio's box invited words for upscale ("optional"), the quote priced
 * them, the press held credits, and the job failed at the worker.
 *
 * What would break without these: the box offering words for upscale again; a stale draft's words, or the price check's stand-in,
 * reaching the request; the quote or create route calling the database (a price, a hold) for an upscale with words; video upscale
 * starting to take words.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  rpc: vi.fn(async (_fn: string, _args?: unknown) => ({ data: null as unknown, error: null as unknown })),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async () => {} }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: { id: ORG } }) }));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => ({ id: "u1" }),
  createClient: async () => ({ rpc: h.rpc }),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const PIC = "55555555-5555-4555-8555-555555555555";

const quoteRoute = await import("@/app/api/creative/quote/route");
const jobsRoute = await import("@/app/api/creative/jobs/route");
const { wordsNotTaken } = await import("@/lib/creative/route-around");
const { CREATIVE_ERRORS } = await import("@/lib/creative/operations");
const { promptRule, buildParams, sheetQuoteParams } = await import("@/lib/creative/studio");
const { improveWords, cleanImprovePrompt } = await import("@/lib/creative/improve");
const { dictionaries } = await import("@/lib/i18n");

function post(path: string, body: unknown) {
  return new Request(`https://nightshift.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://nightshift.test" },
    body: JSON.stringify(body),
  });
}
const upscale = (params: Record<string, unknown>, mode?: string) => ({
  org_id: ORG, capability: "upscale", model: "ideogram-upscale", params: { source_asset_id: PIC, factor: 2, ...params },
  ...(mode ? { mode } : {}),
});
const dbCalls = () => h.rpc.mock.calls.map(([f]) => f);

beforeEach(() => {
  h.rpc.mockReset().mockImplementation(async (fn: string) => {
    if (fn === "quote_creative_job") return { data: { credits: 3, model: "ideogram-upscale", capability: "upscale", available: 100 }, error: null };
    if (fn === "create_creative_job") return { data: { job: { id: "22222222-2222-4222-8222-222222222222", quoted_credits: 3 }, replay: false }, error: null };
    if (fn === "sellable_models") return { data: [{ id: "ideogram-upscale", display_name: "Ideogram Upscale", spec: {} }], error: null };
    return { data: [], error: null };
  });
});

describe("the Studio does not invite words for picture upscale", () => {
  it("the box's rule is none, for Improve too, and video upscale is unchanged", () => {
    expect(promptRule("upscale")).toBe("none");
    expect(improveWords("upscale")).toBe("none");
    expect(cleanImprovePrompt("upscale", "faces")).toBe("");
    expect(promptRule("video_upscale")).toBe("none");
    expect(promptRule("i2v")).toBe("optional");
  });

  it("never sends words for upscale, even a stale draft's or the price check's stand-in", () => {
    const form = { capability: "upscale" as const, model: "", prompt: "keep it sharp", aspect: "16:9" as const, duration: 5 as const, sourceId: PIC, factor: 2 as const };
    expect(buildParams(form)).toEqual({ source_asset_id: PIC, factor: 2 });
    expect(sheetQuoteParams({ ...form, prompt: "" })).not.toHaveProperty("prompt");
  });
});

describe("the quote and create routes refuse words for picture upscale before anything is priced or held", () => {
  it("the quote, in every mode, answers prompt_not_taken without calling the database", async () => {
    for (const mode of [undefined, "auto", "cheap"]) {
      const res = await quoteRoute.POST(post("/api/creative/quote", upscale({ prompt: "keep it sharp" }, mode)));
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: "prompt_not_taken" });
    }
    expect(dbCalls()).toEqual([]);
  });

  it("the create answers prompt_not_taken without a hold or a job", async () => {
    const res = await jobsRoute.POST(post("/api/creative/jobs", { ...upscale({ prompt: "keep it sharp" }), max_credits: 3, idempotency_key: "k-up-1" }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "prompt_not_taken" });
    expect(dbCalls()).toEqual([]);
  });

  it("an upscale without words is quoted and created as before", async () => {
    expect((await quoteRoute.POST(post("/api/creative/quote", upscale({})))).status).toBe(200);
    expect((await jobsRoute.POST(post("/api/creative/jobs", { ...upscale({}), max_credits: 3, idempotency_key: "k-up-2" }))).status).toBe(201);
  });

  it("only non-empty words are refused, and only for upscale", () => {
    expect(wordsNotTaken("upscale", {})).toBeNull();
    expect(wordsNotTaken("upscale", { prompt: "​﻿ " })).toBeNull();
    expect(wordsNotTaken("upscale", { prompt: "sharp" })?.status).toBe(422);
    expect(wordsNotTaken("i2v", { prompt: "slow push-in" })).toBeNull();
    expect(wordsNotTaken("edit", { prompt: "make the sky red" })).toBeNull();
  });

  it("is a known error code with a sentence in every language", () => {
    expect(CREATIVE_ERRORS).toContain("prompt_not_taken");
    for (const l of ["en", "ru", "uz"] as const) expect(dictionaries[l].creative.errors.prompt_not_taken).toBeTruthy();
  });
});
