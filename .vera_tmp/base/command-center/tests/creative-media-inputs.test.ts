import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null }));
import {
  CREATIVE_CAPABILITIES,
  PARAM_KEYS,
  SOURCE_CAPABILITIES,
  createGeneration,
  mapCreativeError,
  parseGenerationInput,
  type CreativeDb,
  type DbAnswer,
} from "@/lib/creative/operations";
import { CAPABILITIES, coerceSellableModels } from "@/lib/creative/registry";

// Migration 0046: edit / i2v / upscale / remove_bg start from a picture in
// the organization's media library. The Command Center only checks shapes;
// whether the picture may be used is the database's decision.

const ORG = "11111111-2222-4333-8444-555555555555";
const SRC = "ab0c1d1e-0000-4000-8000-00000000a5e7";
const M = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0046_creative_media_inputs.sql"), "utf8");

function parse(capability: string, params: Record<string, unknown>) {
  return parseGenerationInput({ capability, model: "img-x", params, max_credits: 10 }, ORG, { requirePrice: true });
}

function errorOf(r: ReturnType<typeof parse>): { status: number; error?: unknown } | null {
  return r.ok ? null : { status: r.result.status, ...r.result.body };
}

function fn(name: string): string {
  const m = new RegExp(`create or replace function public\\.${name}\\(([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$;`).exec(M);
  if (!m) throw new Error(`no ${name} in 0046`);
  return m[1] + m[2];
}

describe("media-input capabilities in the Command Center", () => {
  it("accepts the four new capabilities and their two params", () => {
    for (const c of ["edit", "i2v", "upscale", "remove_bg"]) expect(CREATIVE_CAPABILITIES).toContain(c);
    expect(PARAM_KEYS).toContain("source_asset_id");
    expect(PARAM_KEYS).toContain("factor");
    expect(CAPABILITIES).toContain("upscale");
    expect(CAPABILITIES).toContain("remove_bg");
  });

  it("passes a well-formed request through untouched", () => {
    const r = parse("upscale", { source_asset_id: SRC, factor: 4 });
    expect(r.ok && r.input.params).toEqual({ source_asset_id: SRC, factor: 4 });
    expect(parse("edit", { prompt: "make it night", source_asset_id: SRC }).ok).toBe(true);
    expect(parse("i2v", { source_asset_id: SRC, duration_s: 5 }).ok).toBe(true);
    expect(parse("remove_bg", { source_asset_id: SRC }).ok).toBe(true);
  });

  it("requires an asset id (never a URL or a path) for every source capability", () => {
    for (const c of SOURCE_CAPABILITIES) {
      for (const bad of [undefined, "", "https://evil.example/x.png", "../../media/ab/x", 42]) {
        const params: Record<string, unknown> = { prompt: "x", factor: 2 };
        if (c !== "upscale") delete params.factor;
        if (bad !== undefined) params.source_asset_id = bad;
        expect(errorOf(parse(c, params))?.error, `${c} ${String(bad)}`).toBe("invalid_params");
      }
    }
  });

  it("refuses a source or a factor where it would be ignored", () => {
    expect(errorOf(parse("t2i", { prompt: "x", source_asset_id: SRC }))?.error).toBe("invalid_params");
    expect(errorOf(parse("edit", { prompt: "x", source_asset_id: SRC, factor: 2 }))?.error).toBe("invalid_params");
    for (const f of [undefined, 3, "2", 8]) {
      expect(errorOf(parse("upscale", { source_asset_id: SRC, factor: f }))?.error).toBe("invalid_params");
    }
  });

  it("maps the database's source refusal to its own code, with the database's sentence", () => {
    const r = mapCreativeError({ code: "NS400", message: "source_unavailable", details: "source_asset_id names no image in this organization's library" });
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ error: "source_unavailable", detail: "source_asset_id names no image in this organization's library" });
  });

  it("sends the asset id to create_creative_job as a param, under the member's session", async () => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const answer: DbAnswer = { data: null, error: { code: "NS400", message: "source_unavailable", details: "x" } };
    const db: CreativeDb = {
      async rpc(f, args) {
        calls.push({ fn: f, args });
        return answer;
      },
      async readJob() {
        return { data: null, error: null };
      },
      async listJobs() {
        return { data: [], error: null };
      },
    };
    const r = parse("edit", { prompt: "x", source_asset_id: SRC });
    if (!r.ok) throw new Error("parse");
    const out = await createGeneration(db, r.input);
    expect(out.body.error).toBe("source_unavailable");
    expect(calls).toEqual([
      expect.objectContaining({ fn: "create_creative_job", args: expect.objectContaining({ p_params: { prompt: "x", source_asset_id: SRC } }) }),
    ]);
  });

  it("reads the upscale factors a model is sold for, and nothing else", () => {
    const row = {
      id: "ideogram-upscale",
      display_name: "Ideogram Upscale",
      provider: "ideogram",
      capabilities: ["upscale", "teleport"],
      availability: "beta",
      verified_at: "2026-10-01T00:00:00Z",
      credit_unit: "model_ideogram_upscale_image",
      entitlement: null,
      credits_per_unit: "3",
      margin: "0",
      spec: { output: "image", unit: "image", limits: { max_prompt_chars: 2000, max_concurrent_per_org: 2 }, upscale_factors: [2, 3, "4"] },
    };
    const [m] = coerceSellableModels([row]);
    expect(m.capabilities).toEqual(["upscale"]);
    expect(m.spec.upscaleFactors).toEqual([2]);
  });
});

describe("0046 in SQL", () => {
  it("checks the source inside the quote, for the job's own organization", () => {
    const price = fn("creative_price");
    expect(price).toMatch(/problem := public\.creative_source_problem\(p_org, cap, p_params\);/);
    expect(price).toMatch(/creative_refuse\('source_unavailable', problem\)/);
    const src = fn("creative_source_problem");
    expect(src).toMatch(/and org_id = p_org/);
    expect(src).toMatch(/deleted_at is null and purged_at is null/);
  });

  it("leaves the money to 0036: no hold, capture or release is touched here", () => {
    expect(M).not.toMatch(/reserve_credits|capture_credits|release_credits|creative_platform_re/);
    expect(M).not.toMatch(/create or replace function public\.(create_creative_job|finish_creative_job|creative_end_locked)\b/);
  });

  it("keeps the worker's new calls to the service role and the source check to nobody", () => {
    expect(M).toMatch(/grant execute on function public\.creative_job_source\(uuid, text\) to service_role;/);
    expect(M).toMatch(/grant execute on function public\.attach_creative_job_assets\(uuid, text, uuid\[\]\) to service_role;/);
    expect(M).not.toMatch(/grant execute on function public\.creative_source_problem/);
    expect(M).not.toMatch(/to anon|to authenticated;\s*$/m);
    expect(fn("creative_job_source")).toMatch(/credits_trusted_caller\(\)/);
    expect(fn("attach_creative_job_assets")).toMatch(/a\.org_id = j\.org_id and a\.source = 'generated'/);
  });
});
