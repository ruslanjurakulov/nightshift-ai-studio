// @vitest-environment jsdom
/**
 * Sound toggle (migration 0070): a clip from a model that prices its soundtrack
 * apart is shown as silent / with sound, each with the price the database gave
 * it. Silent is the default (what the worker sends when none is named); the
 * choice is sent as `audio`; a model without the choice never gets one, and a
 * setting without a price is said so and cannot be picked (never shown as free).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null }));
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

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { coerceSellableModels } from "@/lib/creative/registry";
import { buildParams, effectiveSound, prefillFromJob, sheetQuoteParams, withTiers, type StudioForm, type StudioJob, type StudioModel } from "@/lib/creative/studio";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const PIC = "22222222-2222-4222-8222-222222222222";
const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const SOUND: StudioModel = { id: "sing", displayName: "Sound Clip", capabilities: ["t2v", "i2v"], beta: false, soundChoice: true };
const MUTE: StudioModel = { id: "mute", displayName: "Plain Clip", capabilities: ["t2v", "i2v"], beta: false };
const INITIAL = { capability: "t2v" as const, model: "sing", prompt: "a paper boat", aspect: "16:9" as const, duration: 5 as const };

/** The database's prices: silent / with sound, null = no row. */
let credits: { silent: number | null; sound: number | null };
let quotes: Array<{ model: string; capability: string; params: Record<string, unknown> }>;
let fetchMock: ReturnType<typeof vi.fn>;
const creates = () =>
  fetchMock.mock.calls.filter(([u, init]) => u === "/api/creative/jobs" && (init as RequestInit | undefined)?.method === "POST");

beforeEach(() => {
  credits = { silent: 3, sound: 6 };
  quotes = [];
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/creative/quote") {
      const body = JSON.parse(String(init?.body));
      quotes.push(body);
      if (body.model === "mute") {
        // The database refuses audio on a model that does not price it.
        if ("audio" in body.params) return json({ error: "invalid_params" }, 400);
        return json({ quote: { credits: 2 } });
      }
      const c = body.params.audio === true ? credits.sound : credits.silent;
      return c == null ? json({ error: "unpriced" }, 422) : json({ quote: { credits: c, audio: body.params.audio === true } });
    }
    if (url === "/api/creative/jobs" && init?.method === "POST") return json({ job: { id: "j1" }, replay: false }, 201);
    if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
    if (url.startsWith("/api/style-kits")) return json({ error: "not_available" }, 503);
    if (url.startsWith("/api/media")) return json({ available: true, assets: [], uploads: [] });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const form = (over: Partial<StudioForm>): StudioForm => ({
  capability: "t2v",
  prompt: "",
  aspect: "16:9",
  duration: 5,
  sourceId: null,
  factor: 2,
  ...over,
});

describe("the soundtrack in the request", () => {
  it("is sent for t2v and i2v when a choice is made, and left out otherwise", () => {
    expect(buildParams(form({ prompt: "x", audio: true }))).toMatchObject({ audio: true });
    expect(buildParams(form({ prompt: "x", audio: false }))).toMatchObject({ audio: false });
    expect(buildParams(form({ prompt: "x" }))).not.toHaveProperty("audio");
    expect(buildParams(form({ prompt: "x", audio: null }))).not.toHaveProperty("audio");
    expect(buildParams(form({ capability: "i2v", sourceId: PIC, audio: true }))).toMatchObject({ audio: true, source_asset_id: PIC });
  });

  it("is never sent for a tool that has no soundtrack", () => {
    for (const capability of ["t2i", "edit", "upscale", "remove_bg", "describe", "tts"] as const) {
      expect(buildParams(form({ capability, prompt: "x", sourceId: PIC, audio: true })), capability).not.toHaveProperty("audio");
    }
  });

  it("is the model's own: silent unless picked, and none for a model without the choice", () => {
    expect(effectiveSound(SOUND, null)).toBe(false);
    expect(effectiveSound(SOUND, true)).toBe(true);
    expect(effectiveSound(MUTE, true)).toBeNull();
    expect(effectiveSound(null, true)).toBeNull();
  });

  it("is not part of the sheet's own settings: each model is priced at its own", () => {
    expect(sheetQuoteParams(form({ prompt: "x" }))).not.toHaveProperty("audio");
  });

  it("comes back with Try again", () => {
    const job = { capability: "t2v", model: "sing", params: { prompt: "x", duration_s: 5, audio: true }, status: "succeeded" } as unknown as StudioJob;
    expect(prefillFromJob(job)).toMatchObject({ audio: true });
    const bad = { ...job, params: { prompt: "x", duration_s: 5, audio: "yes" } } as unknown as StudioJob;
    expect(prefillFromJob(bad)).not.toHaveProperty("audio");
  });
});

describe("the models that offer the choice come from the database's public spec", () => {
  const row = (id: string, spec: Record<string, unknown>) => ({ id, spec });
  it("needs sound AND a price that varies by it", () => {
    const m = (id: string) => ({ ...MUTE, id });
    const out = withTiers(
      [m("a"), m("b"), m("c"), m("d")],
      [
        row("a", { audio_out: true, price_variants_by: "audio" }),
        row("b", { audio_out: true, price_variants_by: "resolution_audio" }),
        row("c", { audio_out: true, price_variants_by: "resolution" }),
        row("d", { audio_out: false, price_variants_by: "audio" }),
      ],
    );
    expect(out.map((x) => x.soundChoice === true)).toEqual([true, true, false, false]);
  });

  it("the public spec carries the pinned resolution and how the price varies", () => {
    const [model] = coerceSellableModels([
      {
        id: "x",
        display_name: "X",
        provider: "p",
        capabilities: ["t2v"],
        availability: "beta",
        verified_at: "2026-09-30T10:00:00Z",
        credit_unit: "model_x_second",
        entitlement: null,
        credits_per_unit: "2",
        margin: "1.5",
        spec: {
          output: "video",
          unit: "second",
          audio_out: true,
          default_resolution: "720p",
          price_variants_by: "resolution_audio",
          limits: { max_prompt_chars: 100, max_concurrent_per_org: 1 },
        },
      },
    ]);
    expect(model.spec.defaultResolution).toBe("720p");
    expect(model.spec.priceVariantsBy).toBe("resolution_audio");
  });
});

describe("the sound toggle", () => {
  it("shows silent and with sound with the price the database gave each, silent picked to start", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[SOUND]} initial={INITIAL} />));
    expect(screen.getByRole("group", { name: t.gen.soundLabel })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("gen-sound-on").textContent).toContain("6 credits"));
    expect(screen.getByTestId("gen-sound-off").textContent).toBe("Silent · 3 credits");
    expect(screen.getByTestId("gen-sound-off").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("gen-sound-on").getAttribute("aria-pressed")).toBe("false");
    // Each number came from a quote of that setting — nothing was computed here.
    expect(new Set(quotes.filter((q) => "audio" in q.params).map((q) => q.params.audio))).toEqual(new Set([false, true]));
  });

  it("prices the button by the setting picked, and sends exactly that setting and price on create", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[SOUND]} initial={INITIAL} />));
    const button = await screen.findByRole("button", { name: /Generate · 3 credits/ });
    fireEvent.click(screen.getByTestId("gen-sound-on"));
    const loud = await screen.findByRole("button", { name: /Generate · 6 credits/ });
    expect(button).toBe(loud);
    fireEvent.click(loud);
    await waitFor(() => expect(creates()).toHaveLength(1));
    const sent = JSON.parse(String((creates()[0][1] as RequestInit).body));
    expect(sent.params).toMatchObject({ prompt: "a paper boat", audio: true });
    // The ceiling is the price the person saw on the button.
    expect(sent.max_credits).toBe(6);
  });

  it("sends silent explicitly by default, so what was priced is what is sent", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[SOUND]} initial={INITIAL} />));
    fireEvent.click(await screen.findByRole("button", { name: /Generate · 3 credits/ }));
    await waitFor(() => expect(creates()).toHaveLength(1));
    expect(JSON.parse(String((creates()[0][1] as RequestInit).body)).params.audio).toBe(false);
  });

  it("is not shown for a model without the choice, and no audio is ever sent to it", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[MUTE]} initial={{ ...INITIAL, model: "mute" }} />));
    await screen.findByRole("button", { name: /Generate · 2 credits/ });
    expect(screen.queryByTestId("gen-sound")).toBeNull();
    expect(quotes.every((q) => !("audio" in q.params))).toBe(true);
  });

  it("is not shown for a picture tool", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[{ ...SOUND, capabilities: ["t2i"] }]} />));
    expect(screen.queryByTestId("gen-sound")).toBeNull();
  });

  it("a setting with no price is said to be unpriced and cannot be picked — never shown as free", async () => {
    credits = { silent: 3, sound: null };
    render(withI18n(<GeneratePanel orgId={ORG} models={[SOUND]} initial={INITIAL} />));
    await waitFor(() => expect(screen.getByTestId("gen-sound-on").textContent).toContain(t.gen.qualityUnpriced));
    const on = screen.getByTestId("gen-sound-on") as HTMLButtonElement;
    expect(on.disabled).toBe(true);
    expect(on.textContent).not.toMatch(/\b0\b/);
    expect(screen.getByTestId("gen-sound-off").textContent).toContain("3 credits");
  });

  it("starts from the setting Try again carries, and spends nothing", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[SOUND]} initial={{ ...INITIAL, audio: true }} />));
    expect(screen.getByTestId("gen-sound-on").getAttribute("aria-pressed")).toBe("true");
    await screen.findByRole("button", { name: /Generate · 6 credits/ });
    expect(creates()).toHaveLength(0);
  });

  it("the model sheet prices each model at its own setting: a model without the choice is asked without one", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[SOUND, MUTE]} initial={INITIAL} />));
    await waitFor(() => expect(screen.getByTestId("gen-sound-on").textContent).toContain("6 credits"));
    fireEvent.click(screen.getByTestId("gen-sound-on"));
    quotes.length = 0;
    fireEvent.click(screen.getByRole("button", { name: t.gen.modelChangeLabel }));
    await waitFor(() => expect(quotes.filter((q) => q.params.prompt === "a paper boat")).toHaveLength(2));
    const sheet = quotes.filter((q) => q.params.prompt === "a paper boat");
    expect(sheet.find((q) => q.model === "sing")?.params.audio).toBe(true);
    expect(sheet.find((q) => q.model === "mute")?.params).not.toHaveProperty("audio");
    expect(creates()).toHaveLength(0);
  });
});

describe("the words", () => {
  it("exist in all three languages and name no vendor", () => {
    for (const lang of ["en", "ru", "uz"] as const) {
      const g = dictionaries[lang].gen;
      for (const text of [g.soundLabel, g.soundOff, g.soundOn, g.soundNote]) {
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toMatch(/seedance|kling|bytedance|byteplus|google|veo/i);
      }
    }
    expect(dictionaries.ru.gen.soundOn).not.toBe(dictionaries.en.gen.soundOn);
    expect(dictionaries.uz.gen.soundOn).not.toBe(dictionaries.en.gen.soundOn);
  });

  it("the panel puts no price in the source: only the database's quote is shown", () => {
    const src = readFileSync(path.join(process.cwd(), "components/studio/GeneratePanel.tsx"), "utf8");
    expect(src).not.toMatch(/credits_per_unit|creditsPerUnit/);
  });
});
