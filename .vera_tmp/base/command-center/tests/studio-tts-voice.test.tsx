// @vitest-environment jsdom
/**
 * Speech in the Studio names its voice. The speech provider refuses a request
 * without one, so the panel asks for a voice (after the words), never sends
 * speech without it, and never picks one on the person's behalf. The voice
 * does not change the price, so the model sheet can price speech as soon as
 * the words are typed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import {
  STUDIO_VOICES,
  blockedReason,
  buildParams,
  prefillFromJob,
  sheetQuoteParams,
  type StudioForm,
  type StudioModel,
} from "@/lib/creative/studio";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const VOICE = STUDIO_VOICES[0].id;
const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const MODELS: StudioModel[] = [{ id: "voice", displayName: "Voice One", capabilities: ["tts"], beta: false }];

const speech = (over: Partial<StudioForm> = {}): StudioForm => ({
  capability: "tts",
  prompt: "",
  aspect: "16:9",
  duration: 5,
  ...over,
});

let quotes: Array<Record<string, unknown>>;
let creates: Array<Record<string, unknown>>;
beforeEach(() => {
  quotes = [];
  creates = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/creative/quote") {
        quotes.push(JSON.parse(String(init?.body)));
        return json({ quote: { credits: 2 } });
      }
      if (url === "/api/creative/jobs" && init?.method === "POST") {
        creates.push(JSON.parse(String(init.body)));
        return json({ job: { id: "j1" } }, 201);
      }
      if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
      if (url.startsWith("/api/style-kits")) return json({ kits: [] });
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("speech params", () => {
  it("sends the picked voice with the words, and no voice key when none is picked", () => {
    expect(buildParams(speech({ prompt: " Salom ", voiceId: VOICE }))).toEqual({ prompt: "Salom", voice_id: VOICE });
    expect(buildParams(speech({ prompt: "Salom" }))).toEqual({ prompt: "Salom" });
    expect(buildParams(speech({ prompt: "Salom", voiceId: "not a voice!" }))).toEqual({ prompt: "Salom" });
  });

  it("asks for the words first, then the voice", () => {
    expect(blockedReason(speech(), true)).toBe("need_words");
    expect(blockedReason(speech({ prompt: "Salom" }), true)).toBe("need_voice");
    expect(blockedReason(speech({ prompt: "Salom", voiceId: VOICE }), true)).toBeNull();
  });

  it("prices speech in the sheet once the words are typed, voice or not", () => {
    expect(sheetQuoteParams(speech())).toBeNull();
    expect(sheetQuoteParams(speech({ prompt: "Salom" }))).toEqual({ prompt: "Salom", voice_id: VOICE });
  });

  it("Try again keeps the voice", () => {
    const p = prefillFromJob({
      id: "j",
      capability: "tts",
      status: "failed",
      requested_model: "voice",
      params: { prompt: "Salom", voice_id: VOICE },
      quoted_credits: 2,
      charged_credits: null,
      error_code: "provider_error",
      result: null,
      result_asset_ids: [],
      created_at: "",
    });
    expect(p).toMatchObject({ capability: "tts", prompt: "Salom", voiceId: VOICE });
  });
});

describe("the Voice tab", () => {
  it("waits for a voice, then prices and creates with it", async () => {
    const { container } = render(withI18n(<GeneratePanel orgId={ORG} models={MODELS} />));
    fireEvent.click(screen.getByRole("tab", { name: t.gen.tabs.tts }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Salom, kanalga xush kelibsiz" } });

    const select = container.querySelector<HTMLSelectElement>("#gen-voice")!;
    expect(container.querySelector('label[for="gen-voice"]')?.textContent).toBe(t.gen.ttsVoiceLabel);
    expect(select.value).toBe("");
    expect(await screen.findByText(t.gen.blocked.need_voice)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes).toHaveLength(0);

    fireEvent.change(select, { target: { value: VOICE } });
    await waitFor(() => expect(quotes.at(-1)?.params).toEqual({ prompt: "Salom, kanalga xush kelibsiz", voice_id: VOICE }), {
      timeout: 2000,
    });
    const generate = await screen.findByRole("button", { name: "Generate · 2 credits" });
    fireEvent.click(generate);
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0]).toMatchObject({ capability: "tts", params: { voice_id: VOICE }, max_credits: 2 });
  });
});
