import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null }));

import { coerceSellableModels, loadSellableModels, readSellableModels } from "../lib/creative/registry";

const good = {
  id: "veo-3.1",
  display_name: "Veo 3.1",
  provider: "google",
  capabilities: ["t2v", "i2v"],
  availability: "beta",
  verified_at: "2026-09-30T10:00:00Z",
  credit_unit: "model_veo_3_1_second",
  entitlement: "models_video:ultra",
  credits_per_unit: "40",
  margin: "0.5",
  spec: {
    output: "video",
    inputs: { image_refs_max: 1 },
    aspect_ratios: ["16:9", "9:16"],
    resolutions: ["720p", "1080p", "4k"],
    durations_s: [4, 6, 8],
    audio_out: true,
    async: true,
    unit: "second",
    attribution: null,
    api_exposure: "any",
    limits: { max_prompt_chars: 2000, max_concurrent_per_org: 1 },
    quality_tier: 5,
    speed_tier: 2,
  },
};

function client(result: { data?: unknown; error?: { code?: string; message?: string } | null }) {
  const calls: unknown[] = [];
  return {
    calls,
    rpc: (fn: string, args: unknown) => {
      calls.push([fn, args]);
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
    },
  };
}

describe("coerceSellableModels", () => {
  it("keeps a verified, priced beta model with its public spec", () => {
    const [m] = coerceSellableModels([good]);
    expect(m.id).toBe("veo-3.1");
    expect(m.creditsPerUnit).toBe(40);
    expect(m.spec.resolutions).toEqual(["720p", "1080p", "4k"]);
    expect(m.spec.maxPromptChars).toBe(2000);
  });

  it("never shows an unverified model, even if a function returned it", () => {
    expect(coerceSellableModels([{ ...good, verified_at: null }])).toEqual([]);
    expect(coerceSellableModels([{ ...good, availability: "hidden" }])).toEqual([]);
    expect(coerceSellableModels([{ ...good, availability: "disabled" }])).toEqual([]);
  });

  it("never shows an unpriced or zero-priced model as a number", () => {
    expect(coerceSellableModels([{ ...good, credits_per_unit: null }])).toEqual([]);
    expect(coerceSellableModels([{ ...good, credits_per_unit: "0" }])).toEqual([]);
    expect(coerceSellableModels([{ ...good, credits_per_unit: "abc" }])).toEqual([]);
  });

  it("drops malformed rows and unknown capabilities instead of guessing", () => {
    expect(coerceSellableModels("nope")).toEqual([]);
    expect(coerceSellableModels([{ ...good, spec: { ...good.spec, unit: "token" } }])).toEqual([]);
    expect(coerceSellableModels([{ ...good, capabilities: ["teleport"] }])).toEqual([]);
    const [m] = coerceSellableModels([{ ...good, capabilities: ["t2v", "teleport"] }]);
    expect(m.capabilities).toEqual(["t2v"]);
  });

  it("keeps a vendor attribution only when it links over https", () => {
    const attributed = { ...good, spec: { ...good.spec, attribution: { text: "Powered by Runway", url: "https://runwayml.com" } } };
    expect(coerceSellableModels([attributed])[0].spec.attribution).toEqual({ text: "Powered by Runway", url: "https://runwayml.com" });
    const bad = { ...good, spec: { ...good.spec, attribution: { text: "x", url: "javascript:alert(1)" } } };
    expect(coerceSellableModels([bad])[0].spec.attribution).toBeNull();
  });
});

describe("readSellableModels", () => {
  it("asks for one capability on the web surface", async () => {
    const c = client({ data: [good] });
    const out = await readSellableModels(c, "t2v");
    expect(out.status).toBe("ok");
    expect(c.calls).toEqual([["sellable_models", { p_capability: "t2v", p_surface: "web" }]]);
  });

  it("says 'not enabled' when migration 0035 is missing, never 'no models'", async () => {
    const out = await readSellableModels(client({ error: { code: "PGRST202", message: "Could not find the function" } }));
    expect(out).toEqual({ status: "not_enabled", models: [] });
  });

  it("reports a refused grant as signed out and anything else as an error", async () => {
    expect((await readSellableModels(client({ error: { code: "42501" } }))).status).toBe("signed_out");
    expect((await readSellableModels(client({ error: { code: "XX000", message: "boom" } }))).status).toBe("error");
  });

  it("degrades to not_configured without Supabase", async () => {
    expect(await loadSellableModels()).toEqual({ status: "not_configured", models: [] });
  });
});
