// @vitest-environment jsdom
/**
 * The video ops (migration 0100): change a library video by a prompt, change
 * its shape without cropping it, take its background out. The params are
 * exactly what 0100's creative_params_problem accepts — the video and ONE
 * thing to ask (words; a shape; nothing) — and NEVER a length: the database
 * prices the video's own measured seconds. The price is the database's, on
 * the button, sent back as the ceiling. While no model is proven and priced
 * the tool says plainly that it is not available on this deployment yet and
 * asks for nothing. A database without 0100 answers "not enabled here yet".
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
  MAX_VIDEO_EDIT_WORDS,
  PARAM_KEYS,
  VIDEO_OP_CAPABILITIES,
  VIDEO_SOURCE_CAPABILITIES,
  createGeneration,
  parseGenerationInput,
  quote,
  videoOpProblem,
  type CreativeDb,
} from "@/lib/creative/operations";
import { CAPABILITIES, coerceSellableModels } from "@/lib/creative/registry";
import { DESK_TOOLS, deskFor, deskFromQuery } from "@/lib/creative/desks";
import { REGISTRY_CAPABILITIES, TASKS, sourceRule, tasksOf } from "@/lib/models-discovery";
import { STUDIO_TOOLS } from "@/lib/navigation";
import {
  COMPOSER_CAPABILITIES,
  PANEL_CAPABILITIES,
  blockedReason,
  buildParams,
  canQuote,
  needsSource,
  needsVideo,
  outputKind,
  prefillFromJob,
  prefillFromQuery,
  promptRule,
  reframeShapesFor,
  sheetQuoteParams,
  withTiers,
  wordsMax,
  type StudioForm,
  type StudioJob,
  type StudioModel,
} from "@/lib/creative/studio";
import type { LibraryAsset } from "@/lib/media";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const VID = "66666666-6666-4666-8666-666666666666";
const LONG = "77777777-7777-4777-8777-777777777777";
const PIC = "22222222-2222-4222-8222-222222222222";
const SQL = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0100_video_ai_ops.sql"), "utf8");

const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const form = (over: Partial<StudioForm>): StudioForm => ({
  capability: "video_edit",
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

function fn(name: string): string {
  const m = new RegExp(`create or replace function public\\.${name}\\(([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$;`).exec(SQL);
  if (!m) throw new Error(`no ${name} in 0100`);
  return m[1] + m[2];
}

const asset = (id: string, name: string, extra: Partial<LibraryAsset>): LibraryAsset => ({
  id,
  kind: "video",
  mime: "video/mp4",
  bytes: 2048,
  width: 1280,
  height: 720,
  durationS: 12.2,
  source: "upload",
  name,
  variants: ["thumb"],
  version: 1,
  createdAt: "2026-10-01T10:00:00Z",
  thumbUrl: `/t/${id}`,
  viewUrl: `/api/media/file/${id}/original`,
  ...extra,
});

const libraryBody = {
  available: true,
  assets: [
    asset(PIC, "lighthouse.png", { kind: "image", mime: "image/png", durationS: null }),
    asset(VID, "promo.mp4", {}),
    asset(LONG, "keynote.mov", { mime: "video/quicktime", durationS: 95 }),
  ],
  uploads: [],
};

const EDITOR: StudioModel = { id: "v-edit", displayName: "Video editor", capabilities: ["video_edit"], beta: true, maxSourceSeconds: 30 };
const REFRAMER: StudioModel = {
  id: "v-reframe",
  displayName: "Video reframer",
  capabilities: ["video_reframe"],
  beta: true,
  maxSourceSeconds: 30,
  reframeAspects: ["16:9", "9:16"],
};
const CUTTER: StudioModel = { id: "v-cut", displayName: "Video cutter", capabilities: ["video_remove_bg"], beta: true, maxSourceSeconds: 30 };
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
        return json({ quote: { credits: 7 } });
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

describe("params (0100's rules)", () => {
  it("video_edit: the video and the words on one line — never a length, a shape or a size", () => {
    expect(buildParams(form({ sourceId: VID, prompt: "  make it\nlook like dusk ", duration: 10, shape: "1:1", factor: 4 }))).toEqual({
      source_asset_id: VID,
      prompt: "make it look like dusk",
    });
    expect((buildParams(form({ sourceId: VID, prompt: "x".repeat(900) })) as { prompt: string }).prompt).toHaveLength(MAX_VIDEO_EDIT_WORDS);
    expect(wordsMax("video_edit")).toBe(500);
  });

  it("video_reframe: the video and the shape; video_remove_bg: the video alone", () => {
    expect(buildParams(form({ capability: "video_reframe", sourceId: VID, shape: "9:16", prompt: "ignored" }))).toEqual({
      source_asset_id: VID,
      aspect_ratio: "9:16",
    });
    expect(buildParams(form({ capability: "video_remove_bg", sourceId: VID, shape: "9:16", prompt: "ignored", target: "4k" }))).toEqual({
      source_asset_id: VID,
    });
  });

  it("the video upscale is built exactly as before", () => {
    expect(buildParams(form({ capability: "video_upscale", sourceId: VID, target: "4k", prompt: "x" }))).toEqual({
      source_asset_id: VID,
      target_resolution: "4k",
    });
    expect(promptRule("video_upscale")).toBe("none");
    expect(needsVideo("video_upscale")).toBe(true);
  });

  it("asks for no price until the video and the one thing to ask are there", () => {
    expect(blockedReason(form({}), true)).toBe("need_video");
    expect(blockedReason(form({ sourceId: VID }), true)).toBe("need_words");
    expect(blockedReason(form({ sourceId: VID, prompt: " \n " }), true)).toBe("need_words");
    expect(blockedReason(form({ sourceId: VID, prompt: "make it night" }), true)).toBeNull();
    expect(blockedReason(form({ capability: "video_reframe", sourceId: VID }), true)).toBe("need_shape");
    expect(blockedReason(form({ capability: "video_reframe", sourceId: VID, shape: "21:9" as never }), true)).toBe("need_shape");
    expect(blockedReason(form({ capability: "video_reframe", sourceId: VID, shape: "1:1" }), true)).toBeNull();
    expect(blockedReason(form({ capability: "video_remove_bg" }), true)).toBe("need_video");
    expect(blockedReason(form({ capability: "video_remove_bg", sourceId: VID }), true)).toBeNull();
    expect(blockedReason(form({ capability: "video_remove_bg", sourceId: VID }), false)).toBe("no_model");
    // The upscale still needs its size.
    expect(blockedReason(form({ capability: "video_upscale", sourceId: VID }), true)).toBe("need_target");
    expect(canQuote(form({ capability: "video_remove_bg", sourceId: VID }))).toBe(true);
  });

  it("the words are required for the edit and absent for the others; all three make a video from a video", () => {
    expect(promptRule("video_edit")).toBe("required");
    expect(promptRule("video_reframe")).toBe("none");
    expect(promptRule("video_remove_bg")).toBe("none");
    for (const c of VIDEO_OP_CAPABILITIES) {
      expect(outputKind(c)).toBe("video");
      expect(needsVideo(c)).toBe(true);
      expect(needsSource(c)).toBe(false);
    }
  });

  it("the model sheet prices a stand-in for the words but never a stand-in shape or a missing video", () => {
    expect(sheetQuoteParams(form({}))).toBeNull();
    expect(sheetQuoteParams(form({ sourceId: VID }))).toEqual({ source_asset_id: VID, prompt: "price check" });
    expect(sheetQuoteParams(form({ capability: "video_reframe", sourceId: VID }))).toBeNull();
    expect(sheetQuoteParams(form({ capability: "video_reframe", sourceId: VID, shape: "1:1" }))).toEqual({
      source_asset_id: VID,
      aspect_ratio: "1:1",
    });
    expect(sheetQuoteParams(form({ capability: "video_remove_bg", sourceId: VID }))).toEqual({ source_asset_id: VID });
  });

  it("Try again and links fill the form only", () => {
    const job = (capability: string, params: Record<string, unknown>): StudioJob => ({
      id: "j",
      capability,
      status: "failed",
      requested_model: "ops",
      params,
      quoted_credits: 7,
      charged_credits: null,
      error_code: "bad_request",
      result: null,
      result_asset_ids: [],
      created_at: "",
    });
    expect(prefillFromJob(job("video_edit", { source_asset_id: VID, prompt: "make it night" }))).toMatchObject({
      capability: "video_edit",
      sourceId: VID,
      prompt: "make it night",
    });
    expect(prefillFromJob(job("video_reframe", { source_asset_id: VID, aspect_ratio: "9:16" }))).toMatchObject({ shape: "9:16", sourceId: VID });
    expect(prefillFromJob(job("video_reframe", { source_asset_id: VID, aspect_ratio: "21:9" }))).toMatchObject({ shape: null });
    expect(prefillFromJob(job("video_remove_bg", { source_asset_id: VID }))).toMatchObject({ sourceId: VID, target: null });
    expect(prefillFromQuery("video_remove_bg", VID)).toMatchObject({ capability: "video_remove_bg", sourceId: VID });
    expect(prefillFromQuery("video_edit", undefined)).toMatchObject({ sourceId: null });
    expect(prefillFromQuery("video_reframe", "https://evil.example/a.mp4")).toBeNull();
  });
});

describe("the route's shape check", () => {
  it("passes a well-formed op through untouched", () => {
    for (const [cap, params] of [
      ["video_edit", { source_asset_id: VID, prompt: "make it night" }],
      ["video_reframe", { source_asset_id: VID, aspect_ratio: "9:16" }],
      ["video_remove_bg", { source_asset_id: VID }],
    ] as const) {
      const r = parse(cap, params);
      expect(r.ok && r.input.params, cap).toEqual(params);
    }
  });

  it("refuses what 0100 refuses", () => {
    const bad = (cap: string, params: Record<string, unknown>) => errorOf(parse(cap, { source_asset_id: VID, ...params }));
    expect(bad("video_edit", {})).toBe("invalid_params");
    expect(bad("video_edit", { prompt: "  " })).toBe("invalid_params");
    expect(bad("video_edit", { prompt: "x".repeat(501) })).toBe("invalid_params");
    expect(bad("video_edit", { prompt: "a\nb" })).toBe("invalid_params");
    expect(bad("video_edit", { prompt: "a\u2028b" })).toBe("invalid_params");
    expect(bad("video_edit", { prompt: "x", aspect_ratio: "16:9" })).toBe("invalid_params");
    expect(bad("video_edit", { prompt: "x", negative_prompt: "y" })).toBe("invalid_params");
    expect(bad("video_edit", { prompt: "x", resolution: "1080p" })).toBe("invalid_params");
    expect(bad("video_edit", { prompt: "x", seed: 1 })).toBe("invalid_params");
    expect(bad("video_edit", { prompt: "x", look: "warm" })).toBe("invalid_params");
    expect(bad("video_edit", { prompt: "x", target_resolution: "4k" })).toBe("invalid_params");
    expect(bad("video_edit", { prompt: "x", factor: 2 })).toBe("invalid_params");
    // A length typed by a client is refused, never priced.
    for (const cap of VIDEO_OP_CAPABILITIES) {
      const extra = cap === "video_edit" ? { prompt: "x" } : cap === "video_reframe" ? { aspect_ratio: "1:1" } : {};
      expect(bad(cap, { ...extra, duration_s: 5 }), cap).toBe("invalid_params");
    }
    for (const aspect of [undefined, "21:9", "16:10", 1, null]) expect(bad("video_reframe", { aspect_ratio: aspect }), String(aspect)).toBe("invalid_params");
    expect(bad("video_reframe", { aspect_ratio: "9:16", prompt: "x" })).toBe("invalid_params");
    expect(bad("video_remove_bg", { prompt: "x" })).toBe("invalid_params");
    expect(bad("video_remove_bg", { aspect_ratio: "9:16" })).toBe("invalid_params");
    expect(errorOf(parse("video_edit", { prompt: "x" }))).toBe("invalid_params");
    expect(errorOf(parse("video_remove_bg", { source_asset_id: "https://evil.example/a.mp4" }))).toBe("invalid_params");
    expect(videoOpProblem("upscale", { source_asset_id: PIC, factor: 2 })).toBeNull();
  });

  it("the video upscale and the picture tools are parsed exactly as before", () => {
    expect(parse("video_upscale", { source_asset_id: VID, target_resolution: "4k" }).ok).toBe(true);
    expect(errorOf(parse("video_upscale", { source_asset_id: VID }))).toBe("invalid_params");
    expect(errorOf(parse("video_upscale", { source_asset_id: VID, target_resolution: "4k", prompt: "x" })) ).toBeNull();
    expect(parse("remove_bg", { source_asset_id: PIC }).ok).toBe(true);
    expect(parse("expand", { source_asset_id: PIC, aspect_ratio: "16:9" }).ok).toBe(true);
  });
});

describe("a database without 0100", () => {
  const db = (code: string, message: string): CreativeDb => ({
    rpc: async () => ({ data: null, error: { code, message, details: "video_edit cannot be generated yet on this deployment" } }),
    readJob: async () => ({ data: null, error: null }),
    listJobs: async () => ({ data: [], error: null }),
  });
  const input = (capability: "video_edit" | "t2v") => ({
    orgId: ORG,
    capability,
    model: "ops",
    params: capability === "video_edit" ? { source_asset_id: VID, prompt: "x" } : { prompt: "x", duration_s: 5 },
    mode: "exact",
    idempotencyKey: "k",
    maxCredits: 7,
  });

  it("answers creative_unavailable for the new ops — never a price and never a crash", async () => {
    expect(await quote(db("NS400", "capability_not_supported"), input("video_edit"))).toEqual({ status: 503, body: { error: "creative_unavailable" } });
    expect(await createGeneration(db("NS400", "capability_not_supported"), input("video_edit"))).toEqual({
      status: 503,
      body: { error: "creative_unavailable" },
    });
  });

  it("leaves every other refusal exactly as it was", async () => {
    expect((await quote(db("NS400", "capability_not_supported"), input("t2v"))).body.error).toBe("capability_not_supported");
    expect((await quote(db("NS400", "unpriced"), input("video_edit"))).body.error).toBe("unpriced");
    expect((await quote(db("NS400", "model_not_sellable"), input("video_edit"))).body.error).toBe("model_not_sellable");
    expect((await quote(db("NS400", "source_unavailable"), input("video_edit"))).body.error).toBe("source_unavailable");
  });
});

describe("pinned to 0100", () => {
  it("the closed shape list and the words' limit are the same in the code and the database", () => {
    const params = fn("creative_params_problem");
    expect(params).toContain(`not in (${EXPAND_ASPECTS.map((x) => `'${x}'`).join(", ")})`);
    expect(params).toContain(`${EXPAND_ASPECTS.join(", ")} for video_reframe`);
    expect(params).toContain(`> ${MAX_VIDEO_EDIT_WORDS} then`);
  });

  it("every capability the code sends is one the database accepts", () => {
    const supported = fn("creative_capability_supported");
    for (const c of VIDEO_OP_CAPABILITIES) {
      expect(supported, c).toContain(`'${c}'`);
      expect(CREATIVE_CAPABILITIES as readonly string[]).toContain(c);
      expect(CAPABILITIES as readonly string[]).toContain(c);
      expect(REGISTRY_CAPABILITIES as readonly string[]).toContain(c);
    }
    // No new param key: 0100 reuses prompt and aspect_ratio.
    expect(PARAM_KEYS).toHaveLength(17);
  });

  it("the price is the video's seconds from the database, never the params", () => {
    expect(fn("creative_price")).toMatch(/'video_edit', 'video_reframe', 'video_remove_bg'\) then\s+[^]*?qty := public\.creative_source_seconds\(p_org, p_params\)/);
    expect(fn("creative_price")).not.toMatch(/p_params\s*->>?\s*'duration_s'/);
    expect(fn("creative_source_problem")).toContain("a.bytes > 26214400");
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
    credit_unit: `model_${id}_second`,
    credits_per_unit: 0.5,
    margin: null,
    spec: { output: "video", unit: "second", limits: { max_prompt_chars: 500, max_concurrent_per_org: 1, max_source_seconds: 30 }, ...spec },
  });

  it("the public spec carries the reframe shapes and the longest video, and nothing it was not proven for", () => {
    const [m] = coerceSellableModels([row("r", ["video_reframe"], { aspect_ratios_by_capability: { video_reframe: ["9:16", "21:9", "16:9"] } })]);
    expect(m.capabilities).toEqual(["video_reframe"]);
    expect(m.spec.reframeAspects).toEqual(["16:9", "9:16"]);
    expect(m.spec.expandAspects).toEqual([]);
    expect(m.spec.maxSourceSeconds).toBe(30);
  });

  it("the Studio's models carry only what the sellable spec states, in the canonical order", () => {
    const out = withTiers(
      [
        { id: "r", displayName: "R", capabilities: ["video_reframe"], beta: false },
        { id: "e", displayName: "E", capabilities: ["video_edit"], beta: false },
      ],
      [
        { id: "r", spec: { aspect_ratios_by_capability: { video_reframe: ["3:4", "16:9", "5:4"] }, limits: { max_source_seconds: 20 } } },
        { id: "e", spec: {} },
      ],
    );
    expect(out[0]).toMatchObject({ reframeAspects: ["16:9", "3:4"], maxSourceSeconds: 20 });
    expect(out[1].reframeAspects).toBeUndefined();
  });

  it("Auto offers a shape some model makes — never the hand-picked model's own list", () => {
    const a: StudioModel = { ...REFRAMER, id: "a", reframeAspects: ["16:9"] };
    const b: StudioModel = { ...REFRAMER, id: "b", reframeAspects: ["1:1", "16:9"] };
    expect(reframeShapesFor([a, b], a, false)).toEqual(["16:9"]);
    expect(reframeShapesFor([a, b], a, true)).toEqual(["16:9", "1:1"]);
    expect(reframeShapesFor([a, b], null, false)).toEqual([]);
  });

  it("the Models page groups them under one task and shows what they take", () => {
    expect(tasksOf(["video_reframe"])).toEqual(["video_edit"]);
    expect(TASKS.find((x) => x.id === "video_edit")?.caps).toEqual([...VIDEO_OP_CAPABILITIES]);
    const rule = sourceRule("video_edit", 30);
    expect(rule).toMatchObject({ kind: "video", maxSeconds: 30, maxMb: 25 });
    expect(rule?.formats).toEqual(["MP4", "MOV", "WebM", "MKV"]);
  });
});

describe("where the tools live", () => {
  it("they are Enhance-desk tools: not in the sidebar, not in the video upscale's list", () => {
    expect(DESK_TOOLS.enhance.slice(6)).toEqual([...VIDEO_OP_CAPABILITIES]);
    for (const c of VIDEO_OP_CAPABILITIES) {
      expect(deskFor(c)).toBe("enhance");
      expect(deskFromQuery({ tool: c })).toBe("enhance");
      expect(STUDIO_TOOLS as readonly string[]).not.toContain(c);
      expect(COMPOSER_CAPABILITIES as readonly string[]).not.toContain(c);
      expect(VIDEO_SOURCE_CAPABILITIES as readonly string[]).not.toContain(c);
      expect(PANEL_CAPABILITIES as readonly string[]).toContain(c);
    }
  });
});

// ── the composer ─────────────────────────────────────────────────────────────

const start = (capability: "video_edit" | "video_reframe" | "video_remove_bg", model: string, over: Record<string, unknown> = {}) => ({
  capability,
  model,
  prompt: "",
  aspect: "16:9" as const,
  duration: 5 as const,
  sourceId: VID,
  ...over,
});

describe("the composer", () => {
  it("while no model is proven and priced: says so plainly and asks for nothing", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[OTHER]} desk="enhance" />));
    for (const c of VIDEO_OP_CAPABILITIES) {
      fireEvent.click(screen.getByRole("tab", { name: new RegExp(t.desk.tools[c]) }));
      expect(screen.getByTestId("gen-no-model").textContent).toBe(t.gen.notAvailableYet);
      expect((screen.getByRole("button", { name: t.gen.generate }) as HTMLButtonElement).disabled).toBe(true);
    }
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes).toEqual([]);
    expect(creates).toEqual([]);
  });

  it("Edit video: pick a video, say what to change, see the database's price, generate at that price", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[EDITOR]} initial={start("video_edit", "v-edit", { sourceId: null })} desk="enhance" />));
    const list = await screen.findByRole("radiogroup", { name: t.gen.videoLabel });
    const rows = within(list).getAllByRole("radio");
    // Videos only, and a video longer than the model takes is shown but not pickable.
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("promo.mp4"), expect.stringContaining("keynote.mov")]);
    expect((rows[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(rows[0]);
    expect(await screen.findByText(t.gen.blocked.need_words)).toBeTruthy();
    expect(quotes).toEqual([]);
    const field = screen.getByLabelText(new RegExp(t.gen.opWords.video_edit)) as HTMLTextAreaElement;
    expect(field.maxLength).toBe(500);
    fireEvent.change(field, { target: { value: "make it look like dusk" } });
    await screen.findByRole("button", { name: "Generate · 7 credits" }, { timeout: 2000 });
    expect(quotes.at(-1)).toEqual({
      org_id: ORG,
      capability: "video_edit",
      model: "v-edit",
      params: { source_asset_id: VID, prompt: "make it look like dusk" },
    });
    expect(screen.getByText(t.gen.videoOpNotes.video_edit)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate · 7 credits" }));
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0]).toMatchObject({ capability: "video_edit", model: "v-edit", max_credits: 7 });
    expect(creates[0].params).toEqual({ source_asset_id: VID, prompt: "make it look like dusk" });
  });

  it("Reframe video: the model's shapes, the first picked to start, a change re-asks the price", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[REFRAMER]} initial={start("video_reframe", "v-reframe")} desk="enhance" />));
    const shapes = within(await screen.findByRole("group", { name: t.gen.reframeLabel })).getAllByRole("button");
    expect(shapes.map((b) => b.textContent)).toEqual(["16:9", "9:16"]);
    await screen.findByRole("button", { name: "Generate · 7 credits" }, { timeout: 2000 });
    expect(quotes.at(-1)?.params).toEqual({ source_asset_id: VID, aspect_ratio: "16:9" });
    fireEvent.click(shapes[1]);
    await waitFor(() => expect(quotes.at(-1)?.params).toEqual({ source_asset_id: VID, aspect_ratio: "9:16" }), { timeout: 2000 });
    // No words field: a reframe is asked by its shape alone.
    expect(screen.queryByLabelText(t.gen.promptLabel)).toBeNull();
    expect(screen.getByText(t.gen.videoOpNotes.video_reframe)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Generate · 7 credits" }, { timeout: 2000 }));
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0].params).toEqual({ source_asset_id: VID, aspect_ratio: "9:16" });
  });

  it("Remove video background: the video alone, no words, no shape, no length", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[CUTTER]} initial={start("video_remove_bg", "v-cut")} desk="enhance" />));
    await screen.findByRole("button", { name: "Generate · 7 credits" }, { timeout: 2000 });
    expect(quotes.at(-1)).toEqual({ org_id: ORG, capability: "video_remove_bg", model: "v-cut", params: { source_asset_id: VID } });
    expect(screen.queryByTestId("gen-looks")).toBeNull();
    expect(screen.getByText(t.gen.videoOpNotes.video_remove_bg)).toBeTruthy();
  });

  it("switching from a picture tool to a video op starts the pick again", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[CUTTER, OTHER]} initial={start("video_remove_bg", "v-cut")} desk="enhance" />));
    fireEvent.click(screen.getByRole("tab", { name: new RegExp(t.desk.tools.upscale) }));
    expect(await screen.findByRole("radiogroup", { name: t.gen.sourceLabel })).toBeTruthy();
    expect(screen.getByText(t.gen.blocked.need_picture)).toBeTruthy();
  });
});

describe("copy", () => {
  it("every language has the new words, and names no provider, model or role", () => {
    for (const [loc, d] of Object.entries(dictionaries)) {
      const g = d.gen;
      const words: string[] = [
        g.reframeLabel,
        g.opWords.video_edit,
        d.modelDiscovery.tasks.video_edit,
        d.modelDiscovery.taskHints.video_edit,
        ...VIDEO_OP_CAPABILITIES.flatMap((c) => [g.kinds[c], g.tabs[c], g.videoOpNotes[c], d.desk.tools[c], d.desk.toolFrom[c]]),
        g.promptPh.video_edit,
      ];
      for (const w of words) {
        expect(w.trim(), loc).not.toBe("");
        expect(w, `${loc}: ${w}`).not.toMatch(/gemini|google|openai|runway|veo|kling|luma|seedance|wan\b|minimax|higgsfield|krea|\bowner\b|\beditor\b|\bviewer\b|\badmin\b/i);
      }
      if (loc !== "en") for (const k of ["reframeLabel"] as const) expect(g[k]).not.toBe(dictionaries.en.gen[k]);
      for (const c of VIDEO_OP_CAPABILITIES) expect(g.videoOpNotes[c]).toMatch(loc === "en" ? /price counts|Library/ : /./);
    }
  });

  it("no new string carries the credits' amounts, plans or prices", () => {
    for (const d of Object.values(dictionaries)) for (const c of VIDEO_OP_CAPABILITIES) expect(d.gen.videoOpNotes[c]).not.toMatch(/\d/);
  });
});
