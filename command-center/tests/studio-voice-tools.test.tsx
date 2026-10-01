// @vitest-environment jsdom
/**
 * The Studio's voice tools (migration 0050): change the voice of a library
 * recording, or dub it into Uzbek, Russian or English. The params are exactly
 * what 0050's creative_params_problem accepts — the recording, the voice or
 * the language, and NEVER a length: the database prices the job from the
 * recording's own measured seconds. No price is asked for until the
 * recording and the voice / language are picked; the voice is never defaulted.
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
import { clipLength } from "@/components/studio/SourcePicker";
import {
  CREATIVE_CAPABILITIES,
  DUB_LANGUAGES,
  MEDIA_SOURCE_CAPABILITIES,
  PARAM_KEYS,
  SOURCE_CAPABILITIES,
  parseGenerationInput,
} from "@/lib/creative/operations";
import { CAPABILITIES, coerceSellableModels } from "@/lib/creative/registry";
import {
  COMPOSER_CAPABILITIES,
  STUDIO_CAPABILITIES,
  STUDIO_VOICES,
  blockedReason,
  buildParams,
  canQuote,
  outputKind,
  prefillFromJob,
  prefillFromQuery,
  promptRule,
  sheetQuoteParams,
  type StudioForm,
  type StudioJob,
  type StudioModel,
} from "@/lib/creative/studio";
import type { LibraryAsset } from "@/lib/media";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const REC = "55555555-5555-4555-8555-555555555555";
const VID = "66666666-6666-4666-8666-666666666666";
const LONG = "77777777-7777-4777-8777-777777777777";
const PIC = "22222222-2222-4222-8222-222222222222";
const VOICE = STUDIO_VOICES[0].id;
const SQL = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0050_voice_tools.sql"), "utf8");

const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const form = (over: Partial<StudioForm>): StudioForm => ({
  capability: "voice_change",
  prompt: "",
  aspect: "16:9",
  duration: 5,
  sourceId: null,
  factor: 2,
  ...over,
});

function parse(capability: string, params: Record<string, unknown>) {
  return parseGenerationInput({ capability, model: "vox", params, max_credits: 10 }, ORG, { requirePrice: true });
}
const errorOf = (r: ReturnType<typeof parse>) => (r.ok ? null : r.result.body.error);

/** The body of a function in 0050, for pins against the code. */
function fn(name: string): string {
  const m = new RegExp(`create or replace function public\\.${name}\\(([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$;`).exec(SQL);
  if (!m) throw new Error(`no ${name} in 0050`);
  return m[1] + m[2];
}

const asset = (id: string, name: string, extra: Partial<LibraryAsset>): LibraryAsset => ({
  id,
  kind: "audio",
  mime: "audio/mpeg",
  bytes: 2048,
  width: null,
  height: null,
  durationS: 61.2,
  source: "upload",
  name,
  variants: [],
  version: 1,
  createdAt: "2026-09-30T10:00:00Z",
  thumbUrl: null,
  viewUrl: `/api/media/file/${id}/original`,
  ...extra,
});

const libraryBody = {
  available: true,
  assets: [
    asset(PIC, "lighthouse.png", { kind: "image", mime: "image/png", durationS: null, thumbUrl: `/t/${PIC}` }),
    asset(REC, "interview.mp3", {}),
    asset(VID, "promo.mp4", { kind: "video", mime: "video/mp4", durationS: 12, thumbUrl: `/t/${VID}` }),
    asset(LONG, "podcast.wav", { mime: "audio/wav", durationS: 900 }),
  ],
  uploads: [],
};

const MODELS: StudioModel[] = [
  { id: "vox", displayName: "Voice tool", capabilities: ["voice_change"], beta: true },
  { id: "dubber", displayName: "Dub tool", capabilities: ["dub"], beta: true },
  { id: "pic", displayName: "Picture tools", capabilities: ["edit"], beta: false },
];

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
        return json({ quote: { credits: 31 } });
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

describe("params (0050's rules)", () => {
  it("voice change: the recording and a picked voice — never a length or words", () => {
    expect(buildParams(form({ sourceId: REC, voiceId: VOICE, prompt: "ignored", duration: 10 }))).toEqual({
      source_asset_id: REC,
      voice_id: VOICE,
    });
  });

  it("dub: the recording and a language — never a length or a voice", () => {
    expect(buildParams(form({ capability: "dub", sourceId: VID, targetLanguage: "uz", voiceId: VOICE }))).toEqual({
      source_asset_id: VID,
      target_language: "uz",
    });
  });

  it("asks for no price until the recording and the voice / language are picked", () => {
    expect(canQuote(form({}))).toBe(false);
    expect(blockedReason(form({}), true)).toBe("need_recording");
    expect(blockedReason(form({ sourceId: REC }), true)).toBe("need_voice");
    expect(blockedReason(form({ sourceId: REC, voiceId: "16516516145" }), true)).toBe("need_voice");
    expect(canQuote(form({ sourceId: REC, voiceId: VOICE }))).toBe(true);
    expect(blockedReason(form({ capability: "dub", sourceId: REC }), true)).toBe("need_language");
    expect(blockedReason(form({ capability: "dub", sourceId: REC, targetLanguage: "de" as never }), true)).toBe("need_language");
    expect(canQuote(form({ capability: "dub", sourceId: REC, targetLanguage: "ru" }))).toBe(true);
    expect(promptRule("voice_change")).toBe("none");
    expect(promptRule("dub")).toBe("none");
  });

  it("the model sheet prices with stand-ins only once a recording is picked (the price reads only its length)", () => {
    expect(sheetQuoteParams(form({}))).toBeNull();
    expect(sheetQuoteParams(form({ sourceId: REC }))).toEqual({ source_asset_id: REC, voice_id: VOICE });
    expect(sheetQuoteParams(form({ capability: "dub", sourceId: REC }))).toEqual({ source_asset_id: REC, target_language: "uz" });
  });

  it("results are audio; Try again and links fill the form only", () => {
    expect(outputKind("voice_change")).toBe("audio");
    expect(outputKind("dub")).toBe("audio");
    const job: StudioJob = {
      id: "j",
      capability: "dub",
      status: "failed",
      requested_model: "dubber",
      params: { source_asset_id: VID, target_language: "ru" },
      quoted_credits: 24,
      charged_credits: null,
      error_code: "bad_request",
      result: null,
      result_asset_ids: [],
      created_at: "",
    };
    expect(prefillFromJob(job)).toMatchObject({ capability: "dub", model: "dubber", sourceId: VID, targetLanguage: "ru" });
    expect(prefillFromJob({ ...job, capability: "voice_change", params: { source_asset_id: VID, voice_id: "x" } })).toMatchObject({
      sourceId: VID,
      voiceId: null,
    });
    expect(prefillFromQuery("voice_change", REC)).toMatchObject({ capability: "voice_change", sourceId: REC });
    expect(prefillFromQuery("dub", "../etc/passwd")).toBeNull();
  });

  it("the sidebar's list is unchanged; the composer adds the voice tools after the picture tools", () => {
    expect([...STUDIO_CAPABILITIES]).toEqual(["t2i", "t2v", "tts", "edit", "i2v", "upscale", "remove_bg"]);
    // (0052's video tools follow them: tests/studio-video-tools.test.tsx.)
    expect([...COMPOSER_CAPABILITIES]).toEqual([...STUDIO_CAPABILITIES, "voice_change", "dub", "video_upscale"]);
    // The Library's "Use in Studio" picture links never offer a voice tool for a picture.
    expect(SOURCE_CAPABILITIES as readonly string[]).not.toContain("voice_change");
  });
});

describe("the route's shape check", () => {
  it("passes a well-formed voice change and dub through untouched", () => {
    const r = parse("voice_change", { source_asset_id: REC, voice_id: VOICE });
    expect(r.ok && r.input.params).toEqual({ source_asset_id: REC, voice_id: VOICE });
    expect(parse("dub", { source_asset_id: REC, target_language: "en" }).ok).toBe(true);
  });

  it("refuses what 0050 refuses", () => {
    expect(errorOf(parse("voice_change", { source_asset_id: REC }))).toBe("invalid_params");
    expect(errorOf(parse("voice_change", { source_asset_id: REC, voice_id: "16516516145" }))).toBe("invalid_params");
    expect(errorOf(parse("voice_change", { source_asset_id: "https://evil.example/a.mp3", voice_id: VOICE }))).toBe("invalid_params");
    expect(errorOf(parse("voice_change", { source_asset_id: REC, voice_id: VOICE, duration_s: 1 }))).toBe("invalid_params");
    for (const lang of [undefined, "de", "UZ", 1]) {
      expect(errorOf(parse("dub", { source_asset_id: REC, target_language: lang })), String(lang)).toBe("invalid_params");
    }
    expect(errorOf(parse("dub", { source_asset_id: REC, target_language: "uz", duration_s: 60 }))).toBe("invalid_params");
    expect(errorOf(parse("tts", { prompt: "x", target_language: "uz" }))).toBe("invalid_params");
  });
});

describe("pinned to 0050", () => {
  it("the language allow-list is the same in the code and the database", () => {
    expect(fn("creative_params_problem")).toContain(`not in (${DUB_LANGUAGES.map((l) => `'${l}'`).join(", ")})`);
  });

  it("every capability and param key the code sends is one 0050 accepts (0052's own are pinned to 0052)", () => {
    const later: readonly string[] = ["video_upscale", "target_resolution", "end_asset_id"];
    const supported = fn("creative_capability_supported");
    for (const c of CREATIVE_CAPABILITIES) if (!later.includes(c)) expect(supported, c).toContain(`'${c}'`);
    const params = fn("creative_params_problem");
    for (const k of PARAM_KEYS) if (!later.includes(k)) expect(params, k).toContain(`'${k}'`);
    for (const c of MEDIA_SOURCE_CAPABILITIES) expect(CAPABILITIES as readonly string[]).toContain(c);
  });

  it("the price of a voice tool comes from the asset row, never the params", () => {
    expect(fn("creative_price")).toContain("qty := public.creative_source_seconds(p_org, p_params)");
    expect(fn("creative_source_seconds")).toContain("ceil(a.duration_s)");
    expect(fn("creative_source_seconds")).not.toMatch(/p_params\s*->>?\s*'duration_s'/);
  });

  it("the public spec carries a dub model's languages", () => {
    const [m] = coerceSellableModels([
      {
        id: "dubber",
        display_name: "Dub",
        provider: "acme",
        capabilities: ["dub"],
        availability: "beta",
        verified_at: "2026-10-01",
        credit_unit: "model_dubber_second",
        credits_per_unit: 2,
        margin: 0,
        spec: { output: "audio", unit: "second", limits: { max_prompt_chars: 1, max_concurrent_per_org: 1 }, languages: ["uz", "ru", "x y"] },
      },
    ]);
    expect(m.capabilities).toEqual(["dub"]);
    expect(m.spec.languages).toEqual(["uz", "ru"]);
  });
});

// ── the composer ─────────────────────────────────────────────────────────────

describe("the composer", () => {
  it("Change voice: pick a recording and a voice, see the database's price, generate at that price", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    fireEvent.click(screen.getByRole("tab", { name: t.gen.tabs.voice_change }));
    expect(screen.queryByLabelText(t.gen.promptLabel)).toBeNull();
    expect(screen.getByText(t.gen.blocked.need_recording)).toBeTruthy();

    const list = await screen.findByRole("radiogroup", { name: t.gen.recordingLabel });
    const rows = within(list).getAllByRole("radio");
    // Audio and video only — never the picture.
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("interview.mp3"),
      expect.stringContaining("promo.mp4"),
      expect.stringContaining("podcast.wav"),
    ]);
    expect(rows[0].textContent).toContain("1:02");
    // Longer than a voice change takes: shown, not pickable.
    expect((rows[2] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(rows[0]);
    expect(screen.getByText(t.gen.blocked.need_voice)).toBeTruthy();
    expect(quotes).toEqual([]);

    fireEvent.change(screen.getByLabelText(t.gen.voiceLabel), { target: { value: VOICE } });
    const button = await screen.findByRole("button", { name: "Generate · 31 credits" }, { timeout: 2000 });
    expect(quotes.at(-1)).toEqual({ org_id: ORG, capability: "voice_change", model: "vox", params: { source_asset_id: REC, voice_id: VOICE } });

    fireEvent.click(button);
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0]).toMatchObject({ capability: "voice_change", model: "vox", max_credits: 31, params: { source_asset_id: REC, voice_id: VOICE } });
    expect(creates[0].params).not.toHaveProperty("duration_s");
  });

  it("Dub / translate: three language chips, the price only once one is picked", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    fireEvent.click(screen.getByRole("tab", { name: t.gen.tabs.dub }));
    const list = await screen.findByRole("radiogroup", { name: t.gen.recordingLabel });
    fireEvent.click(within(list).getAllByRole("radio")[1]);
    const chips = within(screen.getByRole("group", { name: t.gen.languageLabel })).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["O'zbekcha", "Русский", "English"]);
    expect(screen.getByText(t.gen.blocked.need_language)).toBeTruthy();
    fireEvent.click(chips[0]);
    await screen.findByRole("button", { name: "Generate · 31 credits" }, { timeout: 2000 });
    expect(quotes.at(-1)).toMatchObject({ capability: "dub", model: "dubber", params: { source_asset_id: VID, target_language: "uz" } });
  });

  it("switching between a picture tool and a voice tool starts the pick again", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    fireEvent.click(screen.getByRole("tab", { name: t.gen.tabs.dub }));
    const list = await screen.findByRole("radiogroup", { name: t.gen.recordingLabel });
    fireEvent.click(within(list).getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("tab", { name: t.gen.tabs.edit }));
    expect(await screen.findByRole("radiogroup", { name: t.gen.sourceLabel })).toBeTruthy();
    expect(screen.getByText(t.gen.blocked.need_picture)).toBeTruthy();
  });
});

describe("copy", () => {
  it("every language has the new words, and names no provider", () => {
    for (const d of Object.values(dictionaries)) {
      const g = d.gen;
      const words = [
        g.kinds.voice_change,
        g.kinds.dub,
        g.tabs.voice_change,
        g.tabs.dub,
        g.blocked.need_recording,
        g.blocked.need_voice,
        g.blocked.need_language,
        g.recordingLabel,
        g.recordingPick,
        g.recordingEmpty,
        g.voiceChangeNote,
        g.dubNote,
        g.voiceLabel,
        g.voicePick,
        g.languageLabel,
        ...DUB_LANGUAGES.map((l) => g.languages[l]),
      ];
      for (const w of words) {
        expect(w.trim()).not.toBe("");
        expect(w).not.toMatch(/eleven/i);
      }
    }
    expect(dictionaries.ru.gen.tabs.dub).not.toBe(dictionaries.en.gen.tabs.dub);
    expect(dictionaries.uz.gen.tabs.voice_change).not.toBe(dictionaries.en.gen.tabs.voice_change);
  });

  it("formats a clip's length as the price counts it (whole seconds, rounded up)", () => {
    expect(clipLength(61.2)).toBe("1:02");
    expect(clipLength(5)).toBe("0:05");
    expect(clipLength(null)).toBeNull();
  });
});
