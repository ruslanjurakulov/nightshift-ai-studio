// @vitest-environment jsdom
/**
 * The Studio's video tools (migration 0052): upscale a library video to a size
 * the model lists, and end an animated picture on a chosen one. The params are
 * exactly what 0052's creative_params_problem accepts — the video and a size,
 * NEVER a length (the database prices the upscale from the video's own
 * measured seconds); an end frame only for a model that takes one, and the
 * key left out when there is none. No price is asked for until the video is
 * picked; the price is the database's, on the button, sent back as the ceiling.
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
  PARAM_KEYS,
  SOURCE_CAPABILITIES,
  UPSCALE_TARGETS,
  VIDEO_SOURCE_CAPABILITIES,
  parseGenerationInput,
} from "@/lib/creative/operations";
import { CAPABILITIES, coerceSellableModels } from "@/lib/creative/registry";
import {
  COMPOSER_CAPABILITIES,
  PANEL_CAPABILITIES,
  STUDIO_CAPABILITIES,
  blockedReason,
  buildParams,
  canQuote,
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
const VID = "66666666-6666-4666-8666-666666666666";
const LONG = "77777777-7777-4777-8777-777777777777";
const REC = "55555555-5555-4555-8555-555555555555";
const PIC = "22222222-2222-4222-8222-222222222222";
const END = "33333333-3333-4333-8333-333333333333";
const SQL = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0052_video_tools.sql"), "utf8");

const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const form = (over: Partial<StudioForm>): StudioForm => ({
  capability: "video_upscale",
  prompt: "",
  aspect: "16:9",
  duration: 5,
  sourceId: null,
  factor: 2,
  ...over,
});

function parse(capability: string, params: Record<string, unknown>) {
  return parseGenerationInput({ capability, model: "vup", params, max_credits: 10 }, ORG, { requirePrice: true });
}
const errorOf = (r: ReturnType<typeof parse>) => (r.ok ? null : r.result.body.error);

/** The body of a function in 0052, for pins against the code. */
function fn(name: string): string {
  const m = new RegExp(`create or replace function public\\.${name}\\(([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$;`).exec(SQL);
  if (!m) throw new Error(`no ${name} in 0052`);
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
    asset(END, "sunset.png", { kind: "image", mime: "image/png", durationS: null }),
    asset(REC, "interview.mp3", { kind: "audio", mime: "audio/mpeg", durationS: 61, thumbUrl: null }),
    asset(VID, "promo.mp4", {}),
    asset(LONG, "keynote.mov", { mime: "video/quicktime", durationS: 95 }),
  ],
  uploads: [],
};

const UPSCALER: StudioModel = {
  id: "vup",
  displayName: "Video upscaler",
  capabilities: ["video_upscale"],
  beta: true,
  upscaleTargets: ["720p", "4k"],
  maxSourceSeconds: 30,
};
const FRAMER: StudioModel = { id: "framer", displayName: "Framer", capabilities: ["i2v"], beta: false, endFrame: true };
const PLAIN: StudioModel = { id: "plain", displayName: "Plain", capabilities: ["i2v"], beta: false };

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
        return json({ quote: { credits: 26 } });
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

describe("params (0052's rules)", () => {
  it("video upscale: the video and a size — never a length, words or a factor", () => {
    expect(buildParams(form({ sourceId: VID, target: "4k", prompt: "ignored", duration: 10, factor: 4 }))).toEqual({
      source_asset_id: VID,
      target_resolution: "4k",
    });
    expect(promptRule("video_upscale")).toBe("none");
    expect(outputKind("video_upscale")).toBe("video");
  });

  it("animate: the end frame is sent when picked, and left out — never sent empty — when not", () => {
    const base = form({ capability: "i2v", sourceId: PIC, duration: 5 });
    expect(buildParams({ ...base, endFrameId: END })).toEqual({ source_asset_id: PIC, duration_s: 5, end_asset_id: END });
    expect(buildParams(base)).toEqual({ source_asset_id: PIC, duration_s: 5 });
    expect(buildParams({ ...base, endFrameId: "../../etc" })).not.toHaveProperty("end_asset_id");
  });

  it("asks for no price until the video and a size are there", () => {
    expect(canQuote(form({}))).toBe(false);
    expect(blockedReason(form({}), true)).toBe("need_video");
    expect(blockedReason(form({ sourceId: VID }), true)).toBe("need_target");
    expect(blockedReason(form({ sourceId: VID, target: "8k" as never }), true)).toBe("need_target");
    expect(canQuote(form({ sourceId: VID, target: "720p" }))).toBe(true);
  });

  it("the model sheet never prices a stand-in size (each size has its own price)", () => {
    expect(sheetQuoteParams(form({}))).toBeNull();
    expect(sheetQuoteParams(form({ sourceId: VID }))).toBeNull();
    expect(sheetQuoteParams(form({ sourceId: VID, target: "2k" }))).toEqual({ source_asset_id: VID, target_resolution: "2k" });
  });

  it("Try again and links fill the form only", () => {
    const job: StudioJob = {
      id: "j",
      capability: "video_upscale",
      status: "failed",
      requested_model: "vup",
      params: { source_asset_id: VID, target_resolution: "4k" },
      quoted_credits: 26,
      charged_credits: null,
      error_code: "bad_request",
      result: null,
      result_asset_ids: [],
      created_at: "",
    };
    expect(prefillFromJob(job)).toMatchObject({ capability: "video_upscale", model: "vup", sourceId: VID, target: "4k" });
    expect(prefillFromJob({ ...job, params: { source_asset_id: VID, target_resolution: "8k" } })).toMatchObject({ target: null });
    const i2v = { ...job, capability: "i2v", params: { source_asset_id: PIC, end_asset_id: END, duration_s: 5 } };
    expect(prefillFromJob(i2v)).toMatchObject({ capability: "i2v", sourceId: PIC, endFrameId: END });
    expect(prefillFromJob({ ...i2v, params: { source_asset_id: PIC, duration_s: 5 } })).not.toHaveProperty("endFrameId");
    expect(prefillFromQuery("video_upscale", VID)).toMatchObject({ capability: "video_upscale", sourceId: VID });
    expect(prefillFromQuery("video_upscale", undefined)).toMatchObject({ sourceId: null });
    expect(prefillFromQuery("video_upscale", "https://evil.example/a.mp4")).toBeNull();
  });

  it("the video tool comes last in the composer's tabs and in the sidebar", () => {
    expect([...STUDIO_CAPABILITIES]).toEqual(["t2i", "t2v", "tts", "edit", "i2v", "upscale", "remove_bg"]);
    // lib/navigation mirrors COMPOSER_CAPABILITIES, so the sidebar links it too.
    expect(COMPOSER_CAPABILITIES.at(-1)).toBe("video_upscale");
    expect([...PANEL_CAPABILITIES]).toEqual([...COMPOSER_CAPABILITIES]);
    // The Library's "Use in Studio" picture links never offer the video tool for a picture.
    expect(SOURCE_CAPABILITIES as readonly string[]).not.toContain("video_upscale");
  });
});

describe("the route's shape check", () => {
  it("passes a well-formed upscale and a framed animation through untouched", () => {
    const r = parse("video_upscale", { source_asset_id: VID, target_resolution: "1k" });
    expect(r.ok && r.input.params).toEqual({ source_asset_id: VID, target_resolution: "1k" });
    expect(parse("i2v", { source_asset_id: PIC, duration_s: 5, end_asset_id: END }).ok).toBe(true);
  });

  it("refuses what 0052 refuses", () => {
    for (const target of [undefined, "8k", "4K", 4, ""]) {
      expect(errorOf(parse("video_upscale", { source_asset_id: VID, target_resolution: target })), String(target)).toBe(
        "invalid_params",
      );
    }
    expect(errorOf(parse("video_upscale", { target_resolution: "4k" }))).toBe("invalid_params");
    expect(errorOf(parse("video_upscale", { source_asset_id: "https://evil.example/a.mp4", target_resolution: "4k" }))).toBe(
      "invalid_params",
    );
    expect(errorOf(parse("video_upscale", { source_asset_id: VID, target_resolution: "4k", duration_s: 1 }))).toBe("invalid_params");
    expect(errorOf(parse("video_upscale", { source_asset_id: VID, target_resolution: "4k", factor: 2 }))).toBe("invalid_params");
    expect(errorOf(parse("upscale", { source_asset_id: PIC, factor: 2, target_resolution: "4k" }))).toBe("invalid_params");
    expect(errorOf(parse("i2v", { source_asset_id: PIC, duration_s: 5, end_asset_id: "x" }))).toBe("invalid_params");
    expect(errorOf(parse("i2v", { source_asset_id: PIC, duration_s: 5, end_asset_id: null }))).toBe("invalid_params");
    expect(errorOf(parse("t2v", { prompt: "x", duration_s: 5, end_asset_id: END }))).toBe("invalid_params");
  });
});

describe("pinned to 0052", () => {
  it("the size allow-list is the same in the code and the database", () => {
    expect(fn("creative_params_problem")).toContain(`not in (${UPSCALE_TARGETS.map((x) => `'${x}'`).join(", ")})`);
  });

  it("every capability and param key the code sends is one 0052 accepts (0055's own are pinned to 0055)", () => {
    const later: readonly string[] = ["describe", "language", "quality", "audio"];
    const supported = fn("creative_capability_supported");
    for (const c of CREATIVE_CAPABILITIES) if (!later.includes(c)) expect(supported, c).toContain(`'${c}'`);
    const params = fn("creative_params_problem");
    for (const k of PARAM_KEYS) if (!later.includes(k)) expect(params, k).toContain(`'${k}'`);
    for (const c of VIDEO_SOURCE_CAPABILITIES) expect(CAPABILITIES as readonly string[]).toContain(c);
  });

  it("the upscale is priced from the asset row, never the params", () => {
    expect(fn("creative_price")).toMatch(/if cap in \('voice_change', 'dub', 'video_upscale'\) then\s+[^]*?qty := public\.creative_source_seconds\(p_org, p_params\)/);
    expect(fn("creative_price")).not.toMatch(/p_params\s*->>?\s*'duration_s'/);
  });

  it("the public spec carries sizes, the end frame and the longest source", () => {
    const [m] = coerceSellableModels([
      {
        id: "vup",
        display_name: "Up",
        provider: "acme",
        capabilities: ["video_upscale"],
        availability: "beta",
        verified_at: "2026-10-01",
        credit_unit: "model_vup_second",
        credits_per_unit: 1,
        margin: 0,
        spec: {
          output: "video",
          unit: "second",
          limits: { max_prompt_chars: 1, max_concurrent_per_org: 1, max_source_seconds: 30 },
          upscale_targets: ["720p", "8k", "4k"],
          end_frame: "yes",
        },
      },
    ]);
    expect(m.capabilities).toEqual(["video_upscale"]);
    expect(m.spec.upscaleTargets).toEqual(["720p", "4k"]);
    expect(m.spec.maxSourceSeconds).toBe(30);
    expect(m.spec.endFrame).toBe(false);
  });

  it("the Studio's models carry only what the sellable spec states", () => {
    const base: StudioModel[] = [
      { id: "a", displayName: "A", capabilities: ["i2v"], beta: false },
      { id: "b", displayName: "B", capabilities: ["video_upscale"], beta: false },
    ];
    const out = withTiers(base, [
      { id: "a", spec: { end_frame: true } },
      { id: "b", spec: { upscale_targets: ["2k", "16k"], limits: { max_source_seconds: 30 } } },
    ]);
    expect(out[0].endFrame).toBe(true);
    expect(out[1]).toMatchObject({ upscaleTargets: ["2k"], maxSourceSeconds: 30 });
    expect(out[1].endFrame).toBeUndefined();
  });
});

// ── the composer ─────────────────────────────────────────────────────────────

describe("the composer", () => {
  it("Upscale video: pick a video and a size, see the database's price, generate at that price", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[UPSCALER, FRAMER]} />));
    fireEvent.click(screen.getByRole("tab", { name: t.gen.tabs.video_upscale }));
    expect(screen.queryByLabelText(t.gen.promptLabel)).toBeNull();
    expect(screen.getByText(t.gen.blocked.need_video)).toBeTruthy();

    const list = await screen.findByRole("radiogroup", { name: t.gen.videoLabel });
    const rows = within(list).getAllByRole("radio");
    // Videos only — never the picture or the audio file.
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("promo.mp4"), expect.stringContaining("keynote.mov")]);
    // Longer than the model takes: shown, not pickable, in seconds.
    expect((rows[1] as HTMLButtonElement).disabled).toBe(true);
    expect(rows[1].textContent).toContain("longer than 30 s");
    expect(quotes).toEqual([]);
    fireEvent.click(rows[0]);

    // The sizes are the model's own; the first is picked to start with.
    const sizes = within(screen.getByRole("group", { name: t.gen.targetLabel })).getAllByRole("button");
    expect(sizes.map((b) => b.textContent)).toEqual(["720p", "4K"]);
    await screen.findByRole("button", { name: "Generate · 26 credits" }, { timeout: 2000 });
    expect(quotes.at(-1)).toEqual({
      org_id: ORG,
      capability: "video_upscale",
      model: "vup",
      params: { source_asset_id: VID, target_resolution: "720p" },
    });

    fireEvent.click(sizes[1]);
    await waitFor(() => expect(quotes.at(-1)?.params).toEqual({ source_asset_id: VID, target_resolution: "4k" }), { timeout: 2000 });
    const button = await screen.findByRole("button", { name: "Generate · 26 credits" }, { timeout: 2000 });
    fireEvent.click(button);
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0]).toMatchObject({ capability: "video_upscale", model: "vup", max_credits: 26 });
    expect(creates[0].params).toEqual({ source_asset_id: VID, target_resolution: "4k" });
  });

  it("Animate: a model that ends on a chosen picture offers an optional end frame", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[FRAMER]} initial={{ capability: "i2v", model: "framer", prompt: "", aspect: "16:9", duration: 5, sourceId: PIC }} />));
    await screen.findByRole("button", { name: "Generate · 26 credits" }, { timeout: 2000 });
    expect(quotes.at(-1)?.params).toEqual({ source_asset_id: PIC, duration_s: 5 });

    fireEvent.click(screen.getByRole("button", { name: t.gen.endFrameAdd }));
    const ends = await screen.findByRole("radiogroup", { name: t.gen.endFrameLabel });
    fireEvent.click(within(ends).getByRole("radio", { name: "sunset.png" }));
    await waitFor(() => expect(quotes.at(-1)?.params).toEqual({ source_asset_id: PIC, duration_s: 5, end_asset_id: END }), {
      timeout: 2000,
    });

    fireEvent.click(screen.getByRole("button", { name: t.gen.endFrameRemove }));
    await waitFor(() => expect(quotes.at(-1)?.params).toEqual({ source_asset_id: PIC, duration_s: 5 }), { timeout: 2000 });
    expect(screen.getByRole("button", { name: t.gen.endFrameAdd })).toBeTruthy();
  });

  it("Animate: a model that would drop it offers no end frame and is never sent one", async () => {
    render(
      withI18n(
        <GeneratePanel
          orgId={ORG}
          models={[PLAIN]}
          initial={{ capability: "i2v", model: "plain", prompt: "", aspect: "16:9", duration: 5, sourceId: PIC, endFrameId: END }}
        />,
      ),
    );
    await screen.findByRole("button", { name: "Generate · 26 credits" }, { timeout: 2000 });
    expect(screen.queryByTestId("gen-end-frame")).toBeNull();
    expect(quotes.at(-1)?.params).toEqual({ source_asset_id: PIC, duration_s: 5 });
  });

  it("switching between the video tool and a picture tool starts the pick again", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[UPSCALER, FRAMER]} />));
    fireEvent.click(screen.getByRole("tab", { name: t.gen.tabs.video_upscale }));
    const list = await screen.findByRole("radiogroup", { name: t.gen.videoLabel });
    fireEvent.click(within(list).getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("tab", { name: t.gen.tabs.i2v }));
    expect(await screen.findByRole("radiogroup", { name: t.gen.sourceLabel })).toBeTruthy();
    expect(screen.getByText(t.gen.blocked.need_picture)).toBeTruthy();
  });
});

describe("copy", () => {
  it("every language has the new words, and names no provider", () => {
    for (const d of Object.values(dictionaries)) {
      const g = d.gen;
      const words = [
        g.kinds.video_upscale,
        g.tabs.video_upscale,
        g.blocked.need_video,
        g.blocked.need_target,
        g.videoLabel,
        g.videoPick,
        g.videoChange,
        g.videoChosen,
        g.videoEmpty,
        g.videoTooLong,
        g.videoUpscaleNote,
        g.targetLabel,
        g.endFrameLabel,
        g.endFrameAdd,
        g.endFrameRemove,
        g.endFrameNote,
      ];
      for (const w of words) {
        expect(w.trim()).not.toBe("");
        expect(w).not.toMatch(/runway|magnific|veo|kling|luma|seedance|google|bytedance/i);
      }
      expect(g.videoTooLong).toContain("{n}");
    }
    expect(dictionaries.ru.gen.tabs.video_upscale).not.toBe(dictionaries.en.gen.tabs.video_upscale);
    expect(dictionaries.uz.gen.endFrameLabel).not.toBe(dictionaries.en.gen.endFrameLabel);
  });
});
