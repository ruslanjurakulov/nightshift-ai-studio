import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The likeness policy switch (lib/likeness-policy.ts, NIGHTSHIFT_LIKENESS_FEATURES, default OFF).
 *
 * What would break without these: a paid customer starting a real-person face swap, a voice clone or a dub (which re-voices real
 * speakers in their own cloned voice) while Paddle's and Dodo's terms forbid selling it and we told Dodo in writing it is off; a credit
 * hold taken before the refusal; a dub model still listed to a customer; object and background edits refused by mistake; or the
 * switch reading "1"/"true"/unset as on.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null }));

const policy = await import("../lib/likeness-policy");
const ops = await import("../lib/creative/operations");
const registry = await import("../lib/creative/registry");

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A database that records every RPC: create_creative_job is the call that holds credits (0036), quote_creative_job prices. */
function recordingDb() {
  const calls: string[] = [];
  const db = {
    rpc: async (fn: string) => {
      calls.push(fn);
      return { data: { id: "job-1", quoted_credits: 5, credits: 5 }, error: null };
    },
    readJob: async () => ({ data: null, error: null }),
    listJobs: async () => ({ data: [], error: null }),
  };
  return { db: db as unknown as Parameters<typeof ops.createGeneration>[0], calls };
}

function input(capability: string): Parameters<typeof ops.createGeneration>[1] {
  return {
    orgId: "0a000000-0000-4000-8000-00000000000a",
    capability: capability as Parameters<typeof ops.createGeneration>[1]["capability"],
    model: "some-model",
    params: {},
    mode: "exact",
    idempotencyKey: "k-0123456789",
    maxCredits: 10,
  };
}

describe("the switch", () => {
  it("defaults OFF: unset, empty and every near-miss of \"on\" are off", () => {
    delete process.env.NIGHTSHIFT_LIKENESS_FEATURES;
    expect(policy.likenessFeaturesAllowed()).toBe(false);
    for (const v of [undefined, "", "1", "true", "yes", "enabled", "off", "onn"]) expect(policy.likenessFeaturesAllowed(v), String(v)).toBe(false);
    for (const v of ["on", " ON ", "On"]) expect(policy.likenessFeaturesAllowed(v), v).toBe(true);
  });

  it("names its refusal feature_unavailable_policy with a 403", () => {
    expect(policy.likenessRefusal(false)).toEqual({ body: { error: "feature_unavailable_policy" }, status: 403 });
    expect(policy.likenessRefusal(true)).toBeNull();
  });
});

describe("dub (re-voices real speakers in their own voice) through every creative door", () => {
  it("createGeneration refuses it before the database: no create_creative_job, so no credit hold and no ledger row", async () => {
    const { db, calls } = recordingDb();
    const out = await ops.createGeneration(db, input("dub"));
    expect(out).toEqual({ status: 403, body: { error: "feature_unavailable_policy" } });
    expect(calls).toEqual([]);
  });

  it("quote refuses it before the database too: nothing is priced for a tool that cannot be sold", async () => {
    const { db, calls } = recordingDb();
    expect(await ops.quote(db, input("dub"))).toEqual({ status: 403, body: { error: "feature_unavailable_policy" } });
    expect(calls).toEqual([]);
  });

  it.each(["edit", "remove_bg", "t2v", "i2v", "voice_change", "tts"])(
    "%s (no real person's face or voice replaced) still reaches the database with the policy off",
    async (capability) => {
      const { db, calls } = recordingDb();
      await ops.createGeneration(db, input(capability));
      expect(calls).toEqual(["create_creative_job"]);
    },
  );

  it("with the policy on, dub reaches the database again (the switch is the only thing in the way)", async () => {
    vi.stubEnv("NIGHTSHIFT_LIKENESS_FEATURES", "on");
    const { db, calls } = recordingDb();
    await ops.createGeneration(db, input("dub"));
    expect(calls).toEqual(["create_creative_job"]);
  });
});

describe("the model list a customer gets", () => {
  type M = Parameters<typeof registry.withoutLikenessTools>[0][number];
  const model = (id: string, capabilities: string[]) => ({ id, capabilities }) as unknown as M;
  const LIST = [model("dubber", ["dub"]), model("audio-all", ["voice_change", "dub"]), model("editor", ["edit", "remove_bg"])];

  it("drops a dub-only model and strips dub from a model that also does something else", () => {
    const out = registry.withoutLikenessTools(LIST, false);
    expect(out.map((m) => [m.id, m.capabilities])).toEqual([
      ["audio-all", ["voice_change"]],
      ["editor", ["edit", "remove_bg"]],
    ]);
  });

  it("is untouched with the policy on", () => {
    expect(registry.withoutLikenessTools(LIST, true)).toBe(LIST);
  });

  it("is applied by readSellableModels, the one reader of sellable_models() for customer screens", async () => {
    const spec = { output: "audio", unit: "second", limits: { max_prompt_chars: 100, max_concurrent_per_org: 1 } };
    const row = (id: string, capabilities: string[]) =>
      ({ id, display_name: id, provider: "p", availability: "ga", verified_at: "2026-11-01", credit_unit: "u", credits_per_unit: 1, capabilities, spec });
    const rows = [row("dubber", ["dub"]), row("changer", ["voice_change"])];
    // Without the filter both rows are valid models: the parse alone keeps "dubber".
    expect(registry.coerceSellableModels(rows).map((m) => m.id)).toEqual(["dubber", "changer"]);
    const out = await registry.readSellableModels({ rpc: async () => ({ data: rows, error: null }) });
    expect(out.status).toBe("ok");
    expect(out.models.map((m) => m.id)).toEqual(["changer"]);
  });
});

describe("dub through the developer API and the MCP doors (they call api_creative_* / oauth_creative_* themselves)", () => {
  const api = () => import("../lib/api/operations");
  const DUB = { capability: "dub", model: "some-dubber", params: { source_asset_id: "0b000000-0000-4000-8000-00000000000b", target_language: "ru" } };
  function caller() {
    const calls: string[] = [];
    const c = {
      keyHash: "h",
      requestId: "r",
      downloads: false,
      backend: {} as never,
      rpc: async (fn: string) => {
        calls.push(fn);
        return { data: { ok: true, status: 200, data: { id: "q" } }, error: null };
      },
    };
    return { c: c as unknown as Parameters<Awaited<ReturnType<typeof api>>["quoteCreative"]>[0], calls };
  }

  it.each([
    ["quoteCreative", async (o: Awaited<ReturnType<typeof api>>, c: ReturnType<typeof caller>["c"]) => o.quoteCreative(c, DUB)],
    ["createCreative", async (o: Awaited<ReturnType<typeof api>>, c: ReturnType<typeof caller>["c"]) => o.createCreative(c, { ...DUB, max_credits: 10 }, "idem-0123456789")],
    ["oauthQuoteCreative", async (o: Awaited<ReturnType<typeof api>>, c: ReturnType<typeof caller>["c"]) => o.oauthQuoteCreative(c, DUB)],
  ] as const)("%s refuses dub with 403 feature_unavailable_policy before any RPC, and reaches the RPC with the policy on", async (_n, run) => {
    const o = await api();
    const off = caller();
    const res = await run(o, off.c);
    expect(res).toMatchObject({ ok: false, status: 403, code: "feature_unavailable_policy" });
    expect(off.calls).toEqual([]);
    // The same body is a valid request: with the policy on it is the database that answers, so the refusal above is the policy's.
    vi.stubEnv("NIGHTSHIFT_LIKENESS_FEATURES", "on");
    const on = caller();
    await run(o, on.c);
    expect(on.calls).toHaveLength(1);
  });

  it("a model list (API key and OAuth) drops a dub-only model and strips dub from the rest while the policy is off", async () => {
    const o = await api();
    const listed = { ok: true as const, status: 200, data: { capability: null, models: [
      { id: "dubber", capabilities: ["dub"] },
      { id: "audio-all", capabilities: ["voice_change", "dub"] },
      { id: "editor", capabilities: ["edit"] },
    ] } };
    const out = o.withoutLikenessModels(listed, false);
    expect((out as { data: { models: { id: string; capabilities: string[] }[] } }).data.models).toEqual([
      { id: "audio-all", capabilities: ["voice_change"] },
      { id: "editor", capabilities: ["edit"] },
    ]);
    expect(o.withoutLikenessModels(listed, true)).toBe(listed);
  });

  it("listCreativeModels and oauthListCreativeModels apply the filter to what the database answers", async () => {
    const o = await api();
    const rows = { ok: true, status: 200, data: { capability: "dub", models: [{ id: "dubber", capabilities: ["dub"] }] } };
    const c = { keyHash: "h", requestId: "r", downloads: false, backend: {} as never, rpc: async () => ({ data: rows, error: null }) };
    for (const res of [await o.listCreativeModels(c as never, "dub"), await o.oauthListCreativeModels(c as never, "dub")])
      expect((res as { data: { models: unknown[] } }).data.models).toEqual([]);
  });
});

describe("the composer, the canvas and Improve with AI do not offer dub while the policy is off", () => {
  it("offeredTools strips dub (and only dub) unless the policy is on", async () => {
    const { offeredTools, DESK_TOOLS } = await import("../lib/creative/desks");
    expect(offeredTools(DESK_TOOLS.voice, false)).toEqual(["tts", "voice_change"]);
    expect(offeredTools(DESK_TOOLS.enhance, false)).toEqual(DESK_TOOLS.enhance);
    expect(offeredTools(DESK_TOOLS.voice, true)).toEqual(["tts", "voice_change", "dub"]);
  });

  it("the canvas Voice node wired to a recording offers voice_change, not dub", async () => {
    const { toolsFor } = await import("../components/studio-canvas/Inspector");
    const node = { kind: "voice" } as Parameters<typeof toolsFor>[0];
    expect(toolsFor(node, "audio")).toEqual(["voice_change"]);
    vi.stubEnv("NIGHTSHIFT_LIKENESS_FEATURES", "on");
    expect(toolsFor(node, "video")).toEqual(["voice_change", "dub"]);
  });

  it("Improve with AI lists no dub for a video or a recording", async () => {
    const { improveTools } = await import("../lib/creative/improve");
    expect(improveTools("video")).toEqual(["video_upscale", "captions", "voice_change"]);
    expect(improveTools("audio")).toEqual(["voice_change"]);
    expect(improveTools("audio", true)).toEqual(["voice_change", "dub"]);
  });
});

describe("the screens: nothing is shown that the routes refuse", () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");

  it("Character Studio is in the navigation only with both switches on", () => {
    expect(read("app", "(app)", "layout.tsx")).toContain("characterStudio: characterStudioEnabled() && likenessFeaturesAllowed()");
    expect(read("app", "(app)", "[channel]", "sections", "page.tsx")).toContain("characterStudio: characterStudioEnabled() && likenessFeaturesAllowed()");
    expect(read("app", "(app)", "[channel]", "character-studio", "page.tsx")).toContain("if (!characterStudioEnabled() || !likenessFeaturesAllowed()) notFound();");
  });

  it("the custom voice page is the public 404 unless both switches are on (middleware and the page itself)", () => {
    expect(read("middleware.ts")).toContain("customVoiceDecision(request.nextUrl.pathname, customVoiceEnabled() && likenessFeaturesAllowed())");
    expect(read("app", "(app)", "[channel]", "agents", "voice", "page.tsx")).toContain("if (!customVoiceEnabled() || !likenessFeaturesAllowed()) notFound();");
  });
});
