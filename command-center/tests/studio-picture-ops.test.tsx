// @vitest-environment jsdom
/**
 * The picture ops (migration 0099): extend a library picture to another shape,
 * change its light, erase one named object. The params are exactly what 0099's
 * creative_params_problem accepts — the picture and ONE thing to ask (a shape;
 * a named light OR a few words; the object's name) — and the price is always
 * the database's, on the button, sent back as the ceiling. While no model is
 * proven and priced the tool says plainly that it is not available on this
 * deployment yet, and nothing is asked or started. A database without 0099
 * answers "not enabled here yet", never a crash or a price.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/create",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import {
  CREATIVE_CAPABILITIES,
  EXPAND_ASPECTS,
  PARAM_KEYS,
  PICTURE_OP_CAPABILITIES,
  RELIGHT_LOOKS,
  SOURCE_CAPABILITIES,
  createGeneration,
  parseGenerationInput,
  pictureOpProblem,
  quote,
  type CreativeDb,
} from "@/lib/creative/operations";
import { CAPABILITIES, coerceSellableModels } from "@/lib/creative/registry";
import { DESK_TOOLS, deskFor, deskFromQuery } from "@/lib/creative/desks";
import { STUDIO_TOOLS } from "@/lib/navigation";
import {
  COMPARE_CAPABILITIES,
  COMPOSER_CAPABILITIES,
  PANEL_CAPABILITIES,
  blockedReason,
  buildParams,
  canQuote,
  compareSources,
  expandShapesFor,
  needsSource,
  oneLine,
  outputKind,
  prefillFromJob,
  prefillFromQuery,
  promptRule,
  relightLooksFor,
  sheetQuoteParams,
  sourceFromJob,
  withTiers,
  wordsMax,
  type StudioForm,
  type StudioJob,
  type StudioModel,
} from "@/lib/creative/studio";
import type { LibraryAsset } from "@/lib/media";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const PIC = "22222222-2222-4222-8222-222222222222";
const RESULT = "99999999-9999-4999-8999-999999999999";
const SQL = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0099_image_ai_ops.sql"), "utf8");

const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const form = (over: Partial<StudioForm>): StudioForm => ({
  capability: "expand",
  prompt: "",
  aspect: "16:9",
  duration: 5,
  sourceId: null,
  factor: 2,
  ...over,
});

function parse(capability: string, params: Record<string, unknown>) {
  return parseGenerationInput({ capability, model: "ops", params, max_credits: 10 }, ORG, { requirePrice: true });
}
const errorOf = (r: ReturnType<typeof parse>) => (r.ok ? null : r.result.body.error);

/** The body of a function in 0099, for pins against the code. */
function fn(name: string): string {
  const m = new RegExp(`create or replace function public\\.${name}\\(([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$;`).exec(SQL);
  if (!m) throw new Error(`no ${name} in 0099`);
  return m[1] + m[2];
}

const asset = (id: string, name: string): LibraryAsset => ({
  id,
  kind: "image",
  mime: "image/png",
  bytes: 2048,
  width: 1280,
  height: 720,
  durationS: null,
  source: "upload",
  name,
  variants: ["thumb"],
  version: 1,
  createdAt: "2026-10-01T10:00:00Z",
  thumbUrl: `/t/${id}`,
  viewUrl: `/api/media/file/${id}/original`,
});

const libraryBody = { available: true, assets: [asset(PIC, "lighthouse.png")], uploads: [] };

const EXPANDER: StudioModel = {
  id: "ops-expand",
  displayName: "Picture extender",
  capabilities: ["expand"],
  beta: true,
  expandAspects: ["16:9", "1:1", "9:16"],
};
const RELIGHTER: StudioModel = {
  id: "ops-relight",
  displayName: "Picture relighter",
  capabilities: ["relight"],
  beta: true,
  relightLooks: ["soft", "warm", "golden_hour"],
};
const ERASER: StudioModel = { id: "ops-erase", displayName: "Picture eraser", capabilities: ["erase"], beta: true };
const OTHER: StudioModel = { id: "up", displayName: "Upscaler", capabilities: ["upscale"], beta: false };

let quotes: Array<Record<string, unknown>>;
let creates: Array<Record<string, unknown>>;
beforeEach(() => {
  quotes = [];
  creates = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/media")) return json(libraryBody);
      if (url === "/api/creative/quote") {
        quotes.push(JSON.parse(String(init?.body)));
        return json({ quote: { credits: 3 } });
      }
      if (url === "/api/creative/jobs" && init?.method === "POST") {
        creates.push(JSON.parse(String(init.body)));
        return json({ job: { id: "j1" } }, 201);
      }
      if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
      if (url.startsWith("/api/style-kits")) return json({ error: "not_available" }, 503);
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ── the request ──────────────────────────────────────────────────────────────

describe("params (0099's rules)", () => {
  it("expand: the picture and the shape; the words only when typed", () => {
    expect(buildParams(form({ sourceId: PIC, shape: "16:9" }))).toEqual({ source_asset_id: PIC, aspect_ratio: "16:9" });
    expect(buildParams(form({ sourceId: PIC, shape: "1:1", prompt: "  more\nsky  " }))).toEqual({
      source_asset_id: PIC,
      aspect_ratio: "1:1",
      prompt: "more sky",
    });
    // Never the composer's own shape, a size, a factor or a quality.
    expect(buildParams(form({ sourceId: PIC, shape: "4:3", aspect: "9:16", factor: 4, quality: "high" }))).toEqual({
      source_asset_id: PIC,
      aspect_ratio: "4:3",
    });
  });

  it("relight: a named light OR words — never both, never neither", () => {
    const base = form({ capability: "relight", sourceId: PIC });
    expect(buildParams({ ...base, look: "warm" })).toEqual({ source_asset_id: PIC, look: "warm" });
    expect(buildParams({ ...base, prompt: "low sun from the left" })).toEqual({ source_asset_id: PIC, prompt: "low sun from the left" });
    // Typed words win: the chip is not sent next to them (0099 refuses both).
    expect(buildParams({ ...base, look: "warm", prompt: "candlelight" })).toEqual({ source_asset_id: PIC, prompt: "candlelight" });
    // Words that are only white space are no words.
    expect(buildParams({ ...base, look: "cool", prompt: " \n " })).toEqual({ source_asset_id: PIC, look: "cool" });
  });

  it("erase: the picture and the object's name on one line, cut to 200 characters", () => {
    const base = form({ capability: "erase", sourceId: PIC });
    expect(buildParams({ ...base, prompt: "the red car\non the left" })).toEqual({
      source_asset_id: PIC,
      prompt: "the red car on the left",
    });
    expect((buildParams({ ...base, prompt: "x".repeat(500) }) as { prompt: string }).prompt).toHaveLength(200);
    expect(wordsMax("erase")).toBe(200);
    expect(wordsMax("expand")).toBe(300);
    expect(wordsMax("t2i")).toBe(4000);
    expect(oneLine("a   b\t\nc", 100)).toBe("a b c");
  });

  it("asks for no price until the picture and the one thing to ask are there", () => {
    expect(blockedReason(form({}), true)).toBe("need_picture");
    expect(blockedReason(form({ sourceId: PIC }), true)).toBe("need_shape");
    expect(blockedReason(form({ sourceId: PIC, shape: "21:9" as never }), true)).toBe("need_shape");
    expect(blockedReason(form({ sourceId: PIC, shape: "16:9" }), true)).toBeNull();
    expect(blockedReason(form({ capability: "relight", sourceId: PIC }), true)).toBe("need_look");
    expect(blockedReason(form({ capability: "relight", sourceId: PIC, look: "neon" as never }), true)).toBe("need_look");
    expect(blockedReason(form({ capability: "relight", sourceId: PIC, look: "warm" }), true)).toBeNull();
    expect(blockedReason(form({ capability: "relight", sourceId: PIC, prompt: "candlelight" }), true)).toBeNull();
    expect(blockedReason(form({ capability: "erase", sourceId: PIC }), true)).toBe("need_object");
    expect(blockedReason(form({ capability: "erase", sourceId: PIC, prompt: " \n " }), true)).toBe("need_object");
    expect(blockedReason(form({ capability: "erase", sourceId: PIC, prompt: "car" }), true)).toBeNull();
    // No model that can make it: the tool is not for sale.
    expect(blockedReason(form({ sourceId: PIC, shape: "16:9" }), false)).toBe("no_model");
    expect(canQuote(form({ capability: "erase", sourceId: PIC, prompt: "car" }))).toBe(true);
  });

  it("the words are optional for expand and relight and required for erase; none of them takes a style or a tier", () => {
    expect(promptRule("expand")).toBe("optional");
    expect(promptRule("relight")).toBe("optional");
    expect(promptRule("erase")).toBe("required");
    for (const c of PICTURE_OP_CAPABILITIES) {
      expect(outputKind(c)).toBe("image");
      expect(needsSource(c)).toBe(true);
      const p = buildParams(form({ capability: c, sourceId: PIC, shape: "1:1", look: "warm", prompt: "x", styleKitId: PIC, quality: "high" }));
      expect(p).not.toHaveProperty("style_kit_id");
      expect(p).not.toHaveProperty("quality");
      expect(p).not.toHaveProperty("duration_s");
      expect(p).not.toHaveProperty("negative_prompt");
    }
  });

  it("the model sheet prices a stand-in for the words but never a stand-in shape", () => {
    expect(sheetQuoteParams(form({}))).toBeNull();
    expect(sheetQuoteParams(form({ sourceId: PIC }))).toBeNull();
    expect(sheetQuoteParams(form({ sourceId: PIC, shape: "9:16" }))).toMatchObject({ source_asset_id: PIC, aspect_ratio: "9:16" });
    // A relight before a light is picked is priced as a few words (one picture, whatever the light).
    expect(sheetQuoteParams(form({ capability: "relight", sourceId: PIC }))).toEqual({ source_asset_id: PIC, prompt: "price check" });
    expect(sheetQuoteParams(form({ capability: "erase", sourceId: PIC }))).toEqual({ source_asset_id: PIC, prompt: "price check" });
    expect(sheetQuoteParams(form({ capability: "erase", sourceId: null }))).toBeNull();
  });

  it("Try again and links fill the form only", () => {
    const job = (capability: string, params: Record<string, unknown>): StudioJob => ({
      id: "j",
      capability,
      status: "failed",
      requested_model: "ops",
      params,
      quoted_credits: 3,
      charged_credits: null,
      error_code: "bad_request",
      result: null,
      result_asset_ids: [],
      created_at: "",
    });
    expect(prefillFromJob(job("expand", { source_asset_id: PIC, aspect_ratio: "4:3" }))).toMatchObject({
      capability: "expand",
      sourceId: PIC,
      shape: "4:3",
    });
    expect(prefillFromJob(job("expand", { source_asset_id: PIC, aspect_ratio: "21:9" }))).toMatchObject({ shape: null });
    expect(prefillFromJob(job("relight", { source_asset_id: PIC, look: "studio" }))).toMatchObject({ look: "studio" });
    expect(prefillFromJob(job("relight", { source_asset_id: PIC, prompt: "candles" }))).toMatchObject({ look: null, prompt: "candles" });
    expect(prefillFromJob(job("erase", { source_asset_id: PIC, prompt: "the car" }))).toMatchObject({ prompt: "the car", sourceId: PIC });
    expect(prefillFromQuery("erase", PIC)).toMatchObject({ capability: "erase", sourceId: PIC });
    expect(prefillFromQuery("expand", undefined)).toMatchObject({ sourceId: null });
    expect(prefillFromQuery("relight", "https://evil.example/a.png")).toBeNull();
  });

  it("a finished op is shown against its source and its result can start the next tool", () => {
    for (const c of PICTURE_OP_CAPABILITIES) {
      expect(COMPARE_CAPABILITIES as readonly string[]).toContain(c);
      const j = { status: "completed", capability: c, params: { source_asset_id: PIC }, result_asset_ids: [RESULT] };
      expect(compareSources(j)).toEqual({ before: PIC, after: RESULT });
      expect(sourceFromJob(j)).toBe(RESULT);
    }
  });
});

describe("the route's shape check", () => {
  it("passes a well-formed op through untouched", () => {
    for (const [cap, params] of [
      ["expand", { source_asset_id: PIC, aspect_ratio: "16:9" }],
      ["expand", { source_asset_id: PIC, aspect_ratio: "3:4", prompt: "more sky" }],
      ["relight", { source_asset_id: PIC, look: "golden_hour" }],
      ["relight", { source_asset_id: PIC, prompt: "candlelight" }],
      ["erase", { source_asset_id: PIC, prompt: "the red car" }],
    ] as const) {
      const r = parse(cap, params);
      expect(r.ok && r.input.params, cap).toEqual(params);
    }
  });

  it("refuses what 0099 refuses", () => {
    const bad = (cap: string, params: Record<string, unknown>) => errorOf(parse(cap, { source_asset_id: PIC, ...params }));
    for (const aspect of [undefined, "21:9", "16:10", 1, null, "16:9; drop"]) expect(bad("expand", { aspect_ratio: aspect }), String(aspect)).toBe("invalid_params");
    expect(bad("expand", { aspect_ratio: "16:9", prompt: "x".repeat(301) })).toBe("invalid_params");
    expect(bad("expand", { aspect_ratio: "16:9", prompt: "a\nb" })).toBe("invalid_params");
    expect(bad("expand", { aspect_ratio: "16:9", look: "warm" })).toBe("invalid_params");
    expect(bad("expand", { aspect_ratio: "16:9", negative_prompt: "x" })).toBe("invalid_params");
    expect(bad("expand", { aspect_ratio: "16:9", resolution: "1080p" })).toBe("invalid_params");
    expect(bad("expand", { aspect_ratio: "16:9", seed: 3 })).toBe("invalid_params");
    expect(bad("expand", { aspect_ratio: "16:9", factor: 2 })).toBe("invalid_params");
    expect(bad("relight", {})).toBe("invalid_params");
    expect(bad("relight", { look: "warm", prompt: "x" })).toBe("invalid_params");
    expect(bad("relight", { look: "red" })).toBe("invalid_params");
    expect(bad("relight", { look: null })).toBe("invalid_params");
    expect(bad("relight", { look: "warm", aspect_ratio: "1:1" })).toBe("invalid_params");
    expect(bad("relight", { prompt: "x".repeat(301) })).toBe("invalid_params");
    expect(bad("erase", {})).toBe("invalid_params");
    expect(bad("erase", { prompt: "  " })).toBe("invalid_params");
    expect(bad("erase", { prompt: "x".repeat(201) })).toBe("invalid_params");
    expect(bad("erase", { prompt: "car", look: "warm" })).toBe("invalid_params");
    expect(bad("erase", { prompt: "car", aspect_ratio: "1:1" })).toBe("invalid_params");
    expect(bad("erase", { prompt: "car", mask: "x" })).toBe("invalid_params");
    expect(errorOf(parse("expand", { aspect_ratio: "16:9" }))).toBe("invalid_params");
    expect(errorOf(parse("erase", { source_asset_id: "https://evil.example/a.png", prompt: "car" }))).toBe("invalid_params");
    // A look is relight's alone.
    expect(errorOf(parse("t2i", { prompt: "x", look: "warm" }))).toBe("invalid_params");
    expect(errorOf(parse("edit", { source_asset_id: PIC, prompt: "x", look: "warm" }))).toBe("invalid_params");
    expect(pictureOpProblem("upscale", { source_asset_id: PIC, factor: 2 })).toBeNull();
  });

  it("the other tools are parsed exactly as before", () => {
    expect(parse("upscale", { source_asset_id: PIC, factor: 2 }).ok).toBe(true);
    expect(parse("remove_bg", { source_asset_id: PIC }).ok).toBe(true);
    expect(parse("t2i", { prompt: "x", aspect_ratio: "21:9" }).ok).toBe(true);
    expect(errorOf(parse("edit", { source_asset_id: PIC, prompt: "x", seed: 1, resolution: "1080p" }))).toBeNull();
  });
});

describe("a database without 0099", () => {
  const db = (code: string, message: string): CreativeDb => ({
    rpc: async () => ({ data: null, error: { code, message, details: "expand cannot be generated yet on this deployment" } }),
    readJob: async () => ({ data: null, error: null }),
    listJobs: async () => ({ data: [], error: null }),
  });
  const input = (capability: "expand" | "t2i") => ({
    orgId: ORG,
    capability,
    model: "ops",
    params: capability === "expand" ? { source_asset_id: PIC, aspect_ratio: "16:9" } : { prompt: "x" },
    mode: "exact",
    idempotencyKey: "k",
    maxCredits: 3,
  });

  it("answers creative_unavailable for the new ops — never a price and never a crash", async () => {
    const quoted = await quote(db("NS400", "capability_not_supported"), input("expand"));
    expect(quoted).toEqual({ status: 503, body: { error: "creative_unavailable" } });
    const made = await createGeneration(db("NS400", "capability_not_supported"), input("expand"));
    expect(made).toEqual({ status: 503, body: { error: "creative_unavailable" } });
  });

  it("leaves every other refusal exactly as it was", async () => {
    expect((await quote(db("NS400", "capability_not_supported"), input("t2i"))).body.error).toBe("capability_not_supported");
    expect((await quote(db("NS400", "unpriced"), input("expand"))).body.error).toBe("unpriced");
    expect((await quote(db("NS400", "model_not_sellable"), input("expand"))).body.error).toBe("model_not_sellable");
    expect((await createGeneration(db("NS409", "price_changed"), input("expand"))).body.error).toBe("price_changed");
  });

  it("says so in every language", () => {
    for (const d of Object.values(dictionaries)) expect(d.creative.errors.creative_unavailable.trim()).not.toBe("");
  });
});

describe("pinned to 0099", () => {
  it("the closed lists are the same in the code and the database", () => {
    const params = fn("creative_params_problem");
    expect(params).toContain(`not in (${RELIGHT_LOOKS.map((x) => `'${x}'`).join(", ")})`);
    expect(params).toContain(`not in (${EXPAND_ASPECTS.map((x) => `'${x}'`).join(", ")})`);
    expect(params).toContain(`${EXPAND_ASPECTS.join(", ")} for expand`);
    expect(params).toContain(`look must be one of ${RELIGHT_LOOKS.join(", ")}`);
  });

  it("every capability and param key the code sends is one the database accepts", () => {
    const supported = fn("creative_capability_supported");
    for (const c of PICTURE_OP_CAPABILITIES) expect(supported, c).toContain(`'${c}'`);
    expect(fn("creative_params_problem")).toContain("'look') then");
    expect(PARAM_KEYS as readonly string[]).toContain("look");
    for (const c of PICTURE_OP_CAPABILITIES) {
      expect(CREATIVE_CAPABILITIES as readonly string[]).toContain(c);
      expect(CAPABILITIES as readonly string[]).toContain(c);
    }
  });

  it("the prices come from the quantity of one picture and the model's own lists, never from the params", () => {
    expect(fn("creative_quantity")).toContain("when p_capability in ('expand', 'relight', 'erase') then 1::numeric");
    const price = fn("creative_price");
    expect(price).toContain("qty := public.creative_quantity(cap, p_params);");
    expect(price).toContain("%s does not extend a picture to %s");
    expect(price).toContain("%s does not offer the %s light");
    expect(price).not.toMatch(/p_params\s*->>?\s*'quantity'/);
  });

  it("the words' limits are the same in the code and the database", () => {
    const params = fn("creative_params_problem");
    expect(params).toContain("> 200 then");
    expect(params).toContain("> 300 then");
    expect(wordsMax("erase")).toBe(200);
    expect(wordsMax("relight")).toBe(300);
    expect(fn("creative_source_problem")).toContain("a.bytes > 15728640");
  });
});

// ── the models ───────────────────────────────────────────────────────────────

describe("the models", () => {
  const row = (id: string, caps: string[], spec: Record<string, unknown>) => ({
    id,
    display_name: id,
    provider: "acme",
    capabilities: caps,
    availability: "beta",
    verified_at: "2026-10-01",
    credit_unit: `model_${id}_image`,
    credits_per_unit: 3,
    margin: null,
    spec: { output: "image", unit: "image", limits: { max_prompt_chars: 300, max_concurrent_per_org: 2 }, ...spec },
  });

  it("the public spec carries the shapes and the lights a model was proven for, and nothing it was not", () => {
    const [x, r] = coerceSellableModels([
      row("x", ["expand"], { aspect_ratios_by_capability: { expand: ["16:9", "21:9", "1:1"] } }),
      row("r", ["relight"], { relight_looks: ["warm", "neon", "soft"] }),
    ]);
    expect(x.capabilities).toEqual(["expand"]);
    expect(x.spec.expandAspects).toEqual(["16:9", "1:1"]);
    expect(r.spec.relightLooks).toEqual(["soft", "warm"]);
    expect(r.spec.expandAspects).toEqual([]);
  });

  it("the Studio's models carry only what the sellable spec states, in the canonical order", () => {
    const base: StudioModel[] = [
      { id: "x", displayName: "X", capabilities: ["expand"], beta: false },
      { id: "r", displayName: "R", capabilities: ["relight"], beta: false },
      { id: "e", displayName: "E", capabilities: ["erase"], beta: false },
    ];
    const out = withTiers(base, [
      { id: "x", spec: { aspect_ratios_by_capability: { expand: ["3:4", "16:9", "5:4"] } } },
      { id: "r", spec: { relight_looks: ["studio", "soft", "teal"] } },
      { id: "e", spec: {} },
    ]);
    expect(out[0].expandAspects).toEqual(["16:9", "3:4"]);
    expect(out[1].relightLooks).toEqual(["soft", "studio"]);
    expect(out[2].expandAspects).toBeUndefined();
    expect(out[2].relightLooks).toBeUndefined();
  });

  it("Auto offers a shape or a light some model makes — never the hand-picked model's own list", () => {
    const a: StudioModel = { ...EXPANDER, id: "a", expandAspects: ["16:9"] };
    const b: StudioModel = { ...EXPANDER, id: "b", expandAspects: ["1:1", "16:9"] };
    expect(expandShapesFor([a, b], a, false)).toEqual(["16:9"]);
    expect(expandShapesFor([a, b], a, true)).toEqual(["16:9", "1:1"]);
    expect(expandShapesFor([a, b], null, false)).toEqual([]);
    expect(relightLooksFor([RELIGHTER], RELIGHTER, true)).toEqual(["soft", "warm", "golden_hour"]);
    expect(relightLooksFor([ERASER], ERASER, false)).toEqual([]);
  });
});

describe("where the tools live", () => {
  it("they are Enhance-desk tools: not in the sidebar and not in the Library's links", () => {
    expect(DESK_TOOLS.enhance).toEqual(["upscale", "remove_bg", "video_upscale", "expand", "relight", "erase"]);
    for (const c of PICTURE_OP_CAPABILITIES) {
      expect(deskFor(c)).toBe("enhance");
      expect(deskFromQuery({ tool: c })).toBe("enhance");
      expect(STUDIO_TOOLS as readonly string[]).not.toContain(c);
      expect(COMPOSER_CAPABILITIES as readonly string[]).not.toContain(c);
      expect(SOURCE_CAPABILITIES as readonly string[]).not.toContain(c);
      expect(PANEL_CAPABILITIES as readonly string[]).toContain(c);
    }
  });
});

// ── the composer ─────────────────────────────────────────────────────────────

const start = (capability: "expand" | "relight" | "erase", model: string, over: Record<string, unknown> = {}) => ({
  capability,
  model,
  prompt: "",
  aspect: "16:9" as const,
  duration: 5 as const,
  sourceId: PIC,
  ...over,
});

describe("the composer", () => {
  it("while no model is proven and priced: says so plainly and asks for nothing", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[OTHER]} desk="enhance" />));
    for (const c of PICTURE_OP_CAPABILITIES) {
      fireEvent.click(screen.getByRole("tab", { name: new RegExp(t.desk.tools[c]) }));
      expect(screen.getByTestId("gen-no-model").textContent).toBe(t.gen.notAvailableYet);
      expect(screen.getByText(t.gen.notAvailableYet, { selector: "#gen-status *" })).toBeTruthy();
      const press = screen.getByRole("button", { name: t.gen.generate }) as HTMLButtonElement;
      expect(press.disabled).toBe(true);
    }
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes).toEqual([]);
    expect(creates).toEqual([]);
    // Nowhere does it say a price, a credit amount or a model's name.
    expect(screen.queryByText(/credits/i, { selector: "button *" })).toBeNull();
  });

  it("Extend: the model's shapes, the database's price, generate at that price", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[EXPANDER, OTHER]} initial={start("expand", "ops-expand")} desk="enhance" />));
    const shapes = within(await screen.findByRole("group", { name: t.gen.shapeLabel })).getAllByRole("button");
    expect(shapes.map((b) => b.textContent)).toEqual(["16:9", "9:16", "1:1"]);
    await screen.findByRole("button", { name: "Generate · 3 credits" }, { timeout: 2000 });
    expect(quotes.at(-1)).toEqual({
      org_id: ORG,
      capability: "expand",
      model: "ops-expand",
      params: { source_asset_id: PIC, aspect_ratio: "16:9" },
    });
    fireEvent.click(shapes[2]);
    await waitFor(() => expect(quotes.at(-1)?.params).toEqual({ source_asset_id: PIC, aspect_ratio: "1:1" }), { timeout: 2000 });
    fireEvent.change(screen.getByLabelText(new RegExp(t.gen.opWords.expand)), { target: { value: "more sky" } });
    await waitFor(() => expect(quotes.at(-1)?.params).toEqual({ source_asset_id: PIC, aspect_ratio: "1:1", prompt: "more sky" }), { timeout: 2000 });
    fireEvent.click(await screen.findByRole("button", { name: "Generate · 3 credits" }, { timeout: 2000 }));
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0]).toMatchObject({ capability: "expand", model: "ops-expand", max_credits: 3 });
    expect(creates[0].params).toEqual({ source_asset_id: PIC, aspect_ratio: "1:1", prompt: "more sky" });
  });

  it("Relight: a chip is the light, typing replaces it, and a chip again replaces the words", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[RELIGHTER]} initial={start("relight", "ops-relight")} desk="enhance" />));
    // No light yet: no price is asked for.
    expect(await screen.findByText(t.gen.blocked.need_look)).toBeTruthy();
    expect(quotes).toEqual([]);
    const chips = within(screen.getByTestId("gen-looks")).getAllByRole("button");
    expect(chips.map((b) => b.textContent)).toEqual([t.gen.looks.soft, t.gen.looks.warm, t.gen.looks.golden_hour]);
    fireEvent.click(chips[1]);
    await waitFor(() => expect(quotes.at(-1)?.params).toEqual({ source_asset_id: PIC, look: "warm" }), { timeout: 2000 });
    expect(chips[1].getAttribute("aria-pressed")).toBe("true");

    const words = screen.getByLabelText(new RegExp(t.gen.opWords.relight));
    fireEvent.change(words, { target: { value: "late sun from the left" } });
    await waitFor(() => expect(quotes.at(-1)?.params).toEqual({ source_asset_id: PIC, prompt: "late sun from the left" }), { timeout: 2000 });
    expect(chips[1].getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(chips[0]);
    await waitFor(() => expect(quotes.at(-1)?.params).toEqual({ source_asset_id: PIC, look: "soft" }), { timeout: 2000 });
    expect((words as HTMLTextAreaElement).value).toBe("");
    // Never both in one request.
    for (const q of quotes) {
      const p = q.params as Record<string, unknown>;
      expect("look" in p && "prompt" in p).toBe(false);
    }
  });

  it("Erase: name the object, see the price, generate at that price", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[ERASER]} initial={start("erase", "ops-erase")} desk="enhance" />));
    expect(await screen.findByText(t.gen.blocked.need_object)).toBeTruthy();
    expect(quotes).toEqual([]);
    const field = screen.getByLabelText(new RegExp(t.gen.opWords.erase)) as HTMLTextAreaElement;
    expect(field.maxLength).toBe(200);
    fireEvent.change(field, { target: { value: "the red car" } });
    await screen.findByRole("button", { name: "Generate · 3 credits" }, { timeout: 2000 });
    expect(quotes.at(-1)).toEqual({
      org_id: ORG,
      capability: "erase",
      model: "ops-erase",
      params: { source_asset_id: PIC, prompt: "the red car" },
    });
    // No shape, no style, no quality is ever sent.
    expect(Object.keys(quotes.at(-1)?.params as object).sort()).toEqual(["prompt", "source_asset_id"]);
    fireEvent.click(screen.getByRole("button", { name: "Generate · 3 credits" }));
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0]).toMatchObject({ capability: "erase", model: "ops-erase", max_credits: 3 });
  });

  it("tells the truth about what the tool does: the picture is redrawn as a whole", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[ERASER]} initial={start("erase", "ops-erase")} desk="enhance" />));
    expect(await screen.findByText(t.gen.aiEditNote)).toBeTruthy();
    expect(screen.getByText(t.gen.eraseNote)).toBeTruthy();
  });
});

describe("copy", () => {
  it("every language has the new words, and names no provider, model or role", () => {
    for (const [loc, d] of Object.entries(dictionaries)) {
      const g = d.gen;
      const words: string[] = [
        g.shapeLabel,
        g.lookLabel,
        g.lookOrWords,
        g.expandNote,
        g.relightNote,
        g.eraseNote,
        g.aiEditNote,
        g.notAvailableYet,
        g.blocked.need_shape,
        g.blocked.need_look,
        g.blocked.need_object,
        ...RELIGHT_LOOKS.map((l) => g.looks[l]),
        ...PICTURE_OP_CAPABILITIES.flatMap((c) => [
          g.kinds[c],
          g.tabs[c],
          g.promptPh[c],
          g.opWords[c],
          d.desk.tools[c],
          d.desk.toolFrom[c],
        ]),
      ];
      for (const w of words) {
        expect(w.trim(), loc).not.toBe("");
        expect(w, `${loc}: ${w}`).not.toMatch(/gemini|google|openai|imagen|flux|ideogram|runway|veo|kling|luma|nano ?banana|\bowner\b|\beditor\b|\bviewer\b|\badmin\b/i);
      }
      // Each language says it in its own words.
      if (loc !== "en") for (const k of ["shapeLabel", "lookLabel", "notAvailableYet", "aiEditNote"] as const) expect(g[k]).not.toBe(dictionaries.en.gen[k]);
    }
  });

  it("no new string carries the credits' amounts, plans or prices", () => {
    for (const d of Object.values(dictionaries)) {
      const g = d.gen;
      for (const w of [g.expandNote, g.relightNote, g.eraseNote, g.notAvailableYet]) expect(w).not.toMatch(/\d/);
    }
  });
});
