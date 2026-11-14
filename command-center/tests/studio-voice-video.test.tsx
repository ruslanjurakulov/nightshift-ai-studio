// @vitest-environment jsdom
/**
 * Voice to video (migration 0171): one of the organization's recordings (their own narration, audio only, at most ten
 * minutes) and a look in; a 9:16 video drawn by our own engine out. The params are exactly what 0171's
 * creative_params_problem accepts — the recording and a look, nothing else — and NEVER a length: the database prices the
 * recording's own measured seconds. The price is the database's, on the button, sent back as the ceiling. While no model is
 * proven and priced the tool says plainly that it is not available on this deployment yet and asks for nothing. A database
 * without 0171 answers "not enabled here yet".
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
  EXPLAINER_LOOKS,
  MAX_NARRATION_SECONDS,
  NARRATION_CAPABILITIES,
  PARAM_KEYS,
  createGeneration,
  parseGenerationInput,
  quote,
  voiceVideoProblem,
  type CreativeDb,
} from "@/lib/creative/operations";
import { CAPABILITIES, coerceSellableModels } from "@/lib/creative/registry";
import { DESK_TOOLS, deskFor, deskFromQuery } from "@/lib/creative/desks";
import { REGISTRY_CAPABILITIES, sourceRule, tasksOf } from "@/lib/models-discovery";
import { STUDIO_TOOLS } from "@/lib/navigation";
import { API_CREATIVE_CAPABILITIES } from "@/lib/api/operations";
import { registryName } from "@/lib/creative/model-names";
import {
  COMPOSER_CAPABILITIES,
  PANEL_CAPABILITIES,
  blockedReason,
  buildParams,
  canQuote,
  cardShape,
  explainerLooksFor,
  needsNarration,
  needsRecording,
  outputKind,
  prefillFromJob,
  prefillFromQuery,
  promptRule,
  sheetQuoteParams,
  withTiers,
  type StudioForm,
  type StudioJob,
  type StudioModel,
} from "@/lib/creative/studio";
import type { LibraryAsset } from "@/lib/media";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const REC = "33333333-3333-4333-8333-333333333333";
const LONG = "44444444-4444-4444-8444-444444444444";
const CLIP = "55555555-5555-4555-8555-555555555555";
const ROOT = join(__dirname, "..", "..");
const SQL = readFileSync(join(ROOT, "supabase/migrations/0171_voice_video.sql"), "utf8");
const REGISTRY = JSON.parse(readFileSync(join(ROOT, "schemas/model_registry.json"), "utf8")) as {
  models: { id: string; display_name: string; capabilities: string[]; explainer_looks?: string[]; limits: { max_source_seconds?: number } }[];
};

const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const form = (over: Partial<StudioForm>): StudioForm => ({
  capability: "voice_explainer",
  prompt: "",
  aspect: "16:9",
  duration: 5,
  sourceId: null,
  factor: 2,
  ...over,
});

function parse(capability: string, params: Record<string, unknown>) {
  return parseGenerationInput({ capability, model: "vx", params, max_credits: 10 }, ORG, { requirePrice: true });
}
const errorOf = (r: ReturnType<typeof parse>) => (r.ok ? null : r.result.body.error);
const detailOf = (r: ReturnType<typeof parse>) => (r.ok ? null : String(r.result.body.detail ?? ""));

const asset = (id: string, name: string, extra: Partial<LibraryAsset>): LibraryAsset => ({
  id,
  kind: "audio",
  mime: "audio/mpeg",
  bytes: 2048,
  width: null,
  height: null,
  durationS: 42.5,
  source: "upload",
  name,
  variants: [],
  version: 1,
  createdAt: "2026-10-01T10:00:00Z",
  thumbUrl: null,
  viewUrl: `/api/media/file/${id}/original`,
  ...extra,
});

const libraryBody = {
  available: true,
  assets: [
    asset(REC, "narration.mp3", {}),
    asset(LONG, "lecture.m4a", { mime: "audio/mp4", durationS: 900 }),
    asset(CLIP, "promo.mp4", { kind: "video", mime: "video/mp4", width: 1280, height: 720, durationS: 12 }),
  ],
  uploads: [],
};

const DRAWER: StudioModel = {
  id: "vx",
  displayName: "Voice video",
  capabilities: ["voice_explainer"],
  beta: true,
  maxSourceSeconds: 600,
  explainerLooks: ["dusk", "midnight", "golden", "neon", "paper"],
};
const OTHER: StudioModel = { id: "speech", displayName: "Speech", capabilities: ["tts"], beta: false };

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
        return json({ quote: { credits: 22 } });
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

describe("params (0171's rules)", () => {
  it("the recording and the look, nothing else: never a length, words, a shape or a voice", () => {
    expect(buildParams(form({ sourceId: REC, explainerLook: "neon", prompt: "ignored", duration: 10, shape: "1:1", voiceId: "A".repeat(20) }))).toEqual({
      source_asset_id: REC,
      look: "neon",
    });
    expect(promptRule("voice_explainer")).toBe("none");
  });

  it("asks for the recording first, then the look; nothing is priced before both", () => {
    expect(blockedReason(form({}), true)).toBe("need_recording");
    expect(blockedReason(form({ sourceId: REC }), true)).toBe("need_look");
    expect(blockedReason(form({ sourceId: REC, explainerLook: "dusk" }), true)).toBeNull();
    expect(blockedReason(form({ sourceId: REC, explainerLook: "dusk" }), false)).toBe("no_model");
    expect(canQuote(form({ sourceId: REC }))).toBe(false);
    // The sheet prices each model only for the look asked: no stand-in look is ever quoted.
    expect(sheetQuoteParams(form({ sourceId: REC }))).toBeNull();
    expect(sheetQuoteParams(form({ explainerLook: "dusk" }))).toBeNull();
    expect(sheetQuoteParams(form({ sourceId: REC, explainerLook: "paper" }))).toEqual({ source_asset_id: REC, look: "paper" });
  });

  it("the server refuses what the database would, before it is asked", () => {
    expect(parse("voice_explainer", { source_asset_id: REC, look: "dusk" }).ok).toBe(true);
    const bad = (params: Record<string, unknown>) => parse("voice_explainer", params);
    expect(detailOf(bad({ look: "dusk" }))).toMatch(/source_asset_id \(an audio recording/);
    expect(detailOf(bad({ source_asset_id: REC }))).toMatch(/look \(one of dusk, midnight, golden, neon, paper\) is required/);
    expect(detailOf(bad({ source_asset_id: REC, look: "warm" }))).toMatch(/look \(one of/);
    for (const extra of [{ prompt: "x" }, { aspect_ratio: "9:16" }, { resolution: "1080p" }, { seed: 1 }, { negative_prompt: "x" }, { voice_id: "A".repeat(20) }])
      expect(errorOf(bad({ source_asset_id: REC, look: "dusk", ...extra })), JSON.stringify(extra)).toBe("invalid_params");
    expect(detailOf(bad({ source_asset_id: REC, look: "dusk", duration_s: 30 }))).toMatch(/duration_s does not apply/);
    expect(detailOf(bad({ source_asset_id: REC, look: "dusk", language: "uz" }))).toMatch(/language does not apply/);
    expect(errorOf(bad({ source_asset_id: "https://evil.example/a.mp3", look: "dusk" }))).toBe("invalid_params");
    expect(errorOf(bad({ source_asset_id: REC, look: "dusk", music: "bed.mp3" }))).toBe("invalid_params");
    // A look is still refused on every other tool but relight.
    expect(detailOf(parse("dub", { source_asset_id: REC, target_language: "uz", look: "dusk" }))).toMatch(/look does not apply to dub/);
    expect(voiceVideoProblem("dub", { look: "x" })).toBeNull();
  });

  it("a database without 0171 reads as not enabled here, never as a crash or a price", async () => {
    const db: CreativeDb = {
      rpc: async () => ({ data: null, error: { code: "NS400", message: "capability_not_supported", details: "voice_explainer cannot be generated yet" } }),
      readJob: async () => ({ data: null, error: null }),
      listJobs: async () => ({ data: [], error: null }),
    };
    const parsed = parse("voice_explainer", { source_asset_id: REC, look: "dusk" });
    if (!parsed.ok) throw new Error("parse");
    expect((await quote(db, parsed.input)).body.error).toBe("creative_unavailable");
    expect((await createGeneration(db, parsed.input)).body.error).toBe("creative_unavailable");
  });
});

describe("the closed lists agree", () => {
  it("the looks are the database's, the engine's and the registry's, in the same order", () => {
    expect([...EXPLAINER_LOOKS]).toEqual(["dusk", "midnight", "golden", "neon", "paper"]);
    expect(SQL).toContain(`not in (${EXPLAINER_LOOKS.map((l) => `'${l}'`).join(", ")})`);
    const engine = readFileSync(join(ROOT, "video-engine/src/explainer/types.ts"), "utf8");
    expect(engine).toContain(`export type LookId = ${EXPLAINER_LOOKS.map((l) => `"${l}"`).join(" | ")};`);
    const entry = REGISTRY.models.find((m) => m.capabilities.includes("voice_explainer"));
    expect(entry?.explainer_looks).toEqual([...EXPLAINER_LOOKS]);
    expect(entry?.limits.max_source_seconds).toBe(MAX_NARRATION_SECONDS);
    expect(SQL).toContain(`a.duration_s > ${MAX_NARRATION_SECONDS}`);
    // The Studio names it by the registry's own name, never its id.
    expect(registryName(entry!.id)).toBe(entry!.display_name);
  });

  it("the capability is in every list that names the tools, and adds no param key", () => {
    for (const list of [CREATIVE_CAPABILITIES, CAPABILITIES, REGISTRY_CAPABILITIES, API_CREATIVE_CAPABILITIES, PANEL_CAPABILITIES] as readonly (readonly string[])[])
      expect(list).toContain("voice_explainer");
    expect([...NARRATION_CAPABILITIES]).toEqual(["voice_explainer"]);
    expect(PARAM_KEYS).toHaveLength(17);
    expect(SQL).toContain("'video_remove_bg', 'voice_explainer']::text[];");
  });

  it("the public spec carries the looks it was proven for, and nothing it was not", () => {
    const row = (id: string, spec: Record<string, unknown>) => ({
      id, display_name: id, provider: "nightshift", capabilities: ["voice_explainer"], availability: "beta", verified_at: "2026-11-14",
      credit_unit: `model_${id}_second`, credits_per_unit: 0.5, margin: null,
      spec: { output: "video", unit: "second", limits: { max_prompt_chars: 200, max_concurrent_per_org: 1, max_source_seconds: 600 }, ...spec },
    });
    const [a, b] = coerceSellableModels([row("a", { explainer_looks: ["paper", "sepia", "dusk"] }), row("b", {})]);
    expect(a.spec.explainerLooks).toEqual(["dusk", "paper"]);
    expect(b.spec.explainerLooks).toEqual([]);
    const [m] = withTiers([{ id: "a", displayName: "A", capabilities: ["voice_explainer"], beta: true }], [
      { id: "a", spec: { explainer_looks: ["neon", "dusk", "x"], limits: { max_source_seconds: 120 } } },
    ]);
    expect(m).toMatchObject({ explainerLooks: ["dusk", "neon"], maxSourceSeconds: 120 });
    expect(explainerLooksFor([m], m, false)).toEqual(["dusk", "neon"]);
    expect(explainerLooksFor([m, { ...m, id: "b", explainerLooks: ["paper"] }], null, true)).toEqual(["dusk", "neon", "paper"]);
  });
});

describe("where it lives and what it makes", () => {
  it("a Voice-desk tool: not in the sidebar, not a voice tool's recording list, a video result in 9:16", () => {
    expect(DESK_TOOLS.voice).toContain("voice_explainer");
    expect(deskFor("voice_explainer")).toBe("voice");
    expect(deskFromQuery({ tool: "voice_explainer" })).toBe("voice");
    expect(STUDIO_TOOLS as readonly string[]).not.toContain("voice_explainer");
    expect(COMPOSER_CAPABILITIES as readonly string[]).not.toContain("voice_explainer");
    expect(needsRecording("voice_explainer")).toBe(false);
    expect(needsNarration("voice_explainer")).toBe(true);
    expect(outputKind("voice_explainer")).toBe("video");
    expect(cardShape({ capability: "voice_explainer", params: {}, status: "queued" })).toEqual({ aspect: "9 / 16", asked: true });
    expect(tasksOf(["voice_explainer"])).toEqual(["voice_video"]);
    const rule = sourceRule("voice_explainer", 600);
    expect(rule).toMatchObject({ kind: "recording", maxSeconds: 600, maxMb: 200 });
    expect(rule?.formats).not.toContain("MP4");
  });

  it("Try again and a Library link fill the form, and spend nothing", () => {
    const job = {
      id: "j", capability: "voice_explainer", requested_model: "vx", routed_model: null, params: { source_asset_id: REC, look: "golden" },
      status: "failed", result_asset_ids: [],
    } as unknown as StudioJob;
    expect(prefillFromJob(job)).toMatchObject({ capability: "voice_explainer", sourceId: REC, explainerLook: "golden" });
    expect(prefillFromJob({ ...job, params: { source_asset_id: REC, look: "warm" } } as StudioJob)).toMatchObject({ explainerLook: null });
    expect(prefillFromQuery("voice_explainer", REC)).toMatchObject({ capability: "voice_explainer", sourceId: REC });
    expect(prefillFromQuery("voice_explainer", "not-an-id")).toBeNull();
  });
});

// ── the composer ─────────────────────────────────────────────────────────────

const start = (over: Record<string, unknown> = {}) => ({
  capability: "voice_explainer" as const,
  model: "vx",
  prompt: "",
  aspect: "16:9" as const,
  duration: 5 as const,
  sourceId: null,
  ...over,
});

describe("the composer", () => {
  it("while no model is proven and priced: says so plainly and asks for nothing", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[OTHER]} desk="voice" />));
    fireEvent.click(screen.getByRole("tab", { name: new RegExp(t.desk.tools.voice_explainer) }));
    expect(screen.getByTestId("gen-no-model").textContent).toBe(t.gen.notAvailableYet);
    expect((screen.getByRole("button", { name: t.gen.generate }) as HTMLButtonElement).disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes).toEqual([]);
    expect(creates).toEqual([]);
  });

  it("pick a recording (audio only, too long greyed out), see the database's price, generate at that price", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[DRAWER]} initial={start()} desk="voice" />));
    const list = await screen.findByRole("radiogroup", { name: t.gen.narrationLabel });
    const rows = within(list).getAllByRole("radio");
    // Audio only (the video is not offered) and a recording longer than ten minutes is shown but not pickable.
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("narration.mp3"), expect.stringContaining("lecture.m4a")]);
    expect((rows[1] as HTMLButtonElement).disabled).toBe(true);
    expect(quotes).toEqual([]);
    fireEvent.click(rows[0]);
    // The model's first look is shown picked, and the price is asked for exactly it.
    const looks = within(screen.getByRole("group", { name: t.gen.explainerLookLabel })).getAllByRole("button");
    expect(looks.map((b) => b.textContent)).toEqual(EXPLAINER_LOOKS.map((l) => t.gen.explainerLooks[l]));
    expect(looks[0].getAttribute("aria-pressed")).toBe("true");
    await screen.findByRole("button", { name: "Generate · 22 credits" }, { timeout: 2000 });
    expect(quotes.at(-1)).toEqual({ org_id: ORG, capability: "voice_explainer", model: "vx", params: { source_asset_id: REC, look: "dusk" } });
    fireEvent.click(looks[3]);
    await waitFor(() => expect(quotes.at(-1)?.params).toEqual({ source_asset_id: REC, look: "neon" }), { timeout: 2000 });
    // No words field: the recording is the whole input.
    expect(screen.queryByLabelText(t.gen.promptLabel)).toBeNull();
    expect(screen.getByText(t.gen.voiceVideoNote)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Generate · 22 credits" }, { timeout: 2000 }));
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0]).toMatchObject({ capability: "voice_explainer", model: "vx", max_credits: 22 });
    expect(creates[0].params).toEqual({ source_asset_id: REC, look: "neon" });
  });

  it("a model that draws fewer looks offers only those", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[{ ...DRAWER, explainerLooks: ["paper"] }]} initial={start({ sourceId: REC })} desk="voice" />));
    const looks = within(await screen.findByRole("group", { name: t.gen.explainerLookLabel })).getAllByRole("button");
    expect(looks.map((b) => b.textContent)).toEqual([t.gen.explainerLooks.paper]);
    await waitFor(() => expect(quotes.at(-1)?.params).toEqual({ source_asset_id: REC, look: "paper" }), { timeout: 2000 });
  });

  it("switching from a voice change to the voice video starts the pick again", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[DRAWER, { ...OTHER, capabilities: ["dub"] }]} initial={start({ sourceId: REC })} desk="voice" />));
    fireEvent.click(screen.getByRole("tab", { name: new RegExp(t.desk.tools.dub) }));
    fireEvent.click(screen.getByRole("tab", { name: new RegExp(t.desk.tools.voice_explainer) }));
    expect(await screen.findByText(t.gen.blocked.need_recording)).toBeTruthy();
  });
});

describe("copy", () => {
  it("every language has the new words, and names no provider, vendor or role", () => {
    for (const [loc, d] of Object.entries(dictionaries)) {
      const g = d.gen;
      const words: string[] = [
        g.narrationLabel, g.voiceVideoNote, g.explainerLookLabel, ...EXPLAINER_LOOKS.map((l) => g.explainerLooks[l]),
        g.kinds.voice_explainer, g.tabs.voice_explainer, d.desk.tools.voice_explainer, d.desk.toolFrom.voice_explainer,
        d.modelDiscovery.tasks.voice_video, d.modelDiscovery.taskHints.voice_video,
      ];
      for (const w of words) {
        expect(w.trim(), loc).not.toBe("");
        expect(w, `${loc}: ${w}`).not.toMatch(/gemini|google|openai|whisper|remotion|elevenlabs|\bowner\b|\bviewer\b|\badmin\b/i);
      }
      if (loc !== "en") for (const k of ["narrationLabel", "voiceVideoNote", "explainerLookLabel"] as const) expect(g[k]).not.toBe(dictionaries.en.gen[k]);
      // The note says how it is priced and that no AI image or video model draws it (the AI label decision, docs/AI_DISCLOSURE.md).
      expect(g.voiceVideoNote).toMatch(loc === "en" ? /recording's own length/ : /./);
      expect(g.voiceVideoNote).toMatch(/9:16/);
    }
  });
});
