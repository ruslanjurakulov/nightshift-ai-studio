// @vitest-environment jsdom
/**
 * The Studio's sound tool: Sound effects. It is built so it goes live by itself the day the database sells a model for it, and until
 * then it says plainly that it is not available yet. Music is NOT a Studio tool: Lyria's terms (Google APIs Terms 4(a)) allow it only
 * inside a project's workflow, never as a free-standing prompt-to-song tab.
 *
 * What would break without these:
 *  - a Music tab reappearing in the composer, the desks or a link;
 *  - Lyria read as open to some workspace while its entitlement is a plan tier no workspace is sold;
 *  - a sound effect with no model drawn as a working form, or the Generate key pressable without a reason;
 *  - a sound effect sent without the length the database requires, or with one the model does not list;
 *  - a price on the key that the server did not quote;
 *  - a refusal (bad settings, a country, no price, a lock, too few credits) shown as a generic failure, or not at all;
 *  - a language missing the new words, or Uzbek written with a typewriter apostrophe;
 *  - the sound tool leaking into the sidebar's tool rows, where it would open a tool nobody can use yet.
 */
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
import { DESK_TOOLS, deskFor, deskFromQuery } from "@/lib/creative/desks";
import { STUDIO_TOOLS } from "@/lib/navigation";
import { planGate } from "@/lib/models-discovery";
import { resetCreditsLive, seedCredits } from "@/lib/credits-live";
import {
  COMPOSER_CAPABILITIES,
  PANEL_CAPABILITIES,
  SOUND_TOOLS,
  WORDS_FREE_PRICE,
  buildParams,
  isStudioCapability,
  modelLock,
  outputKind,
  prefillFromQuery,
  promptRule,
  sheetQuoteParams,
  type StudioForm,
  type StudioModel,
} from "@/lib/creative/studio";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";

const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const form = (over: Partial<StudioForm>): StudioForm => ({ capability: "sfx", prompt: "", aspect: "16:9", duration: 5, ...over });

// The real id, so nothing here passes only for a made-up model. It is not on sale today; this stands for the day it is.
const SFX: StudioModel = { id: "elevenlabs-sfx", displayName: "Sound Effects", capabilities: ["sfx"], beta: true, durations: [1, 2, 5, 10] };
const SPEECH: StudioModel = { id: "speech", displayName: "Speech", capabilities: ["tts"], beta: false };

let quotes: Array<Record<string, unknown>>;
let creates: Array<Record<string, unknown>>;
let quoteReply: () => Promise<Response>;
let createReply: () => Promise<Response>;
beforeEach(() => {
  quotes = [];
  creates = [];
  quoteReply = () => json({ quote: { credits: 3 } });
  createReply = () => json({ job: { id: "j1" } }, 201);
  resetCreditsLive();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/creative/quote") {
        quotes.push(JSON.parse(String(init?.body)));
        return quoteReply();
      }
      if (url === "/api/creative/jobs" && init?.method === "POST") {
        creates.push(JSON.parse(String(init.body)));
        return createReply();
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

const press = () => screen.getByRole("button", { name: /^Generate/ }) as HTMLButtonElement;
const openSfx = () => fireEvent.click(screen.getByRole("tab", { name: new RegExp(t.desk.tools.sfx) }));
const status = () => document.getElementById("gen-status")?.textContent ?? "";

// ── the request ──────────────────────────────────────────────────────────────

describe("what the sound tools send", () => {
  it("a sound effect sends its words and the length picked (0228 requires one for sfx)", () => {
    expect(buildParams(form({ capability: "sfx", prompt: "door knock", duration: 2 }))).toEqual({ prompt: "door knock", duration_s: 2 });
    expect(promptRule("sfx")).toBe("required");
  });

  it("a sound effect is priced by its seconds, not its words, so the model sheet can price it before typing", () => {
    expect(WORDS_FREE_PRICE).toContain("sfx");
    expect(sheetQuoteParams(form({ duration: 2 }))).toEqual({ prompt: "price check", duration_s: 2 });
  });

  it("the result is a sound, shown with a player like a voice", () => {
    expect(outputKind("sfx")).toBe("audio");
  });
});

describe("where the sound tools live", () => {
  it("Sound effects is on the Voice desk, after the speech tools; not in the sidebar's tool rows", () => {
    expect(SOUND_TOOLS).toEqual(["sfx"]);
    expect(DESK_TOOLS.voice).toEqual(["tts", "voice_change", "dub", "sfx"]);
    for (const c of SOUND_TOOLS) {
      expect(deskFor(c)).toBe("voice");
      expect(deskFromQuery({ tool: c })).toBe("voice");
      expect(prefillFromQuery(c, undefined)).toMatchObject({ capability: c });
      expect(PANEL_CAPABILITIES as readonly string[]).toContain(c);
      expect(STUDIO_TOOLS as readonly string[]).not.toContain(c);
      expect(COMPOSER_CAPABILITIES as readonly string[]).not.toContain(c);
    }
  });

  it("music is no Studio tool at all: no tab, no desk, no link opens a prompt-to-song form (Lyria's terms, 4(a))", () => {
    expect(isStudioCapability("music")).toBe(false);
    expect(PANEL_CAPABILITIES as readonly string[]).not.toContain("music");
    for (const tools of Object.values(DESK_TOOLS)) expect(tools as readonly string[]).not.toContain("music");
    expect(prefillFromQuery("music", undefined)).toBeNull();
    expect(deskFromQuery({ tool: "music" })).toBe("overview");
    for (const d of Object.values(dictionaries)) {
      expect("music" in d.gen.tabs).toBe(false);
      expect("music" in d.desk.tools).toBe(false);
    }
  });
});

// Lyria as the registry has it today. S6's price migration flips its entitlement to `any`: that migration MUST update this block
// (the expectation becomes "no lock"), or this test is a pin on a state that no longer exists.
describe("Lyria's state today, in the library (no UI)", () => {
  it("its plan-tier entitlement (models_audio:premium) is not on sale to any workspace, purchase or not", () => {
    expect(modelLock("models_audio:premium", null)).toBe("not_on_sale");
    expect(modelLock("models_audio:premium", true)).toBe("not_on_sale");
    expect(planGate("models_audio:premium", true)?.kind).toBe("not_open");
    expect(modelLock("any", null)).toBeNull();
  });
});

// ── the composer ─────────────────────────────────────────────────────────────

describe("with no model on sale (today)", () => {
  it("Sound effects shows the unavailable state and a disabled key with its reason, and asks nothing", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[SPEECH]} desk="voice" />));
    openSfx();
    expect(screen.getByTestId("gen-no-model").textContent).toBe(t.gen.notAvailableYet);
    expect(status()).toBe(t.gen.notAvailableYet);
    expect(press().disabled).toBe(true);
    // The key's reason is read with it.
    expect(press().getAttribute("aria-describedby")).toContain("gen-status");
    // No length is offered for a model that does not exist.
    expect(screen.queryByRole("group", { name: t.gen.durationLabel })).toBeNull();
    fireEvent.change(screen.getByLabelText(new RegExp(t.gen.soundWords.sfx)), { target: { value: "rain on a tin roof" } });
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes).toEqual([]);
    expect(creates).toEqual([]);
    expect(press().textContent).not.toMatch(/\d/);
  });

  it("no other model is offered in its place: speech is never the sound effect tool's fallback", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[SPEECH]} desk="voice" initial={{ capability: "sfx", model: "speech", prompt: "", aspect: "16:9", duration: 5 }} />));
    expect(screen.getByRole("tab", { name: new RegExp(t.desk.tools.sfx) }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("gen-model-name")).toBeNull();
    expect(screen.getByTestId("gen-no-model").textContent).toBe(t.gen.notAvailableYet);
  });
});

describe("the sound effect form, once a model is sold", () => {
  it("has the words, the model and the model's own lengths, and sends the one picked", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[SFX]} desk="voice" initial={{ capability: "sfx", model: SFX.id, prompt: "a door knock", aspect: "16:9", duration: 7 }} />));
    expect((screen.getByLabelText(t.gen.soundWords.sfx) as HTMLElement).tagName).toBe("TEXTAREA");
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Sound Effects");
    const lengths = within(screen.getByRole("group", { name: t.gen.durationLabel })).getAllByRole("button");
    expect(lengths).toHaveLength(4);
    // 7 s is not on the list: the nearest listed length is sent, and the form says so.
    await screen.findByRole("button", { name: "Generate · 3 credits" }, { timeout: 2000 });
    expect(quotes.at(-1)).toEqual({ org_id: ORG, capability: "sfx", model: SFX.id, params: { prompt: "a door knock", duration_s: 5 } });
    expect(screen.getByTestId("gen-snap-note").textContent).toContain("5 s");
    fireEvent.click(lengths[1]);
    await waitFor(() => expect(quotes.at(-1)?.params).toEqual({ prompt: "a door knock", duration_s: 2 }), { timeout: 2000 });
    fireEvent.click(await screen.findByRole("button", { name: "Generate · 3 credits" }, { timeout: 2000 }));
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0]).toMatchObject({ capability: "sfx", model: SFX.id, max_credits: 3, params: { prompt: "a door knock", duration_s: 2 } });
  });

  it.each([
    ["an empty list", []],
    ["no list at all (the clip stand-in of 5 and 10 s is never offered for a sound)", undefined],
  ] as const)("a model with %s is not quoted: the sound's own reason is named", async (_, durations) => {
    const model: StudioModel = { ...SFX, durations: durations === undefined ? undefined : [...durations] };
    render(withI18n(<GeneratePanel orgId={ORG} models={[model]} desk="voice" initial={{ capability: "sfx", model: SFX.id, prompt: "a door knock", aspect: "16:9", duration: 5 }} />));
    expect(status()).toBe(t.gen.noSoundLength.replace("{model}", "Sound Effects"));
    expect(screen.queryByRole("group", { name: t.gen.durationLabel })).toBeNull();
    expect(press().disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes).toEqual([]);
  });

  it("under Auto, models that list no length are not quoted at a raw 5 s: the reason is named, without a model's name", async () => {
    const other: StudioModel = { ...SFX, id: "sfx-two", displayName: "Other Sounds" };
    render(
      withI18n(
        <GeneratePanel
          orgId={ORG}
          models={[{ ...SFX, durations: undefined }, { ...other, durations: [] }]}
          desk="voice"
          initial={{ capability: "sfx", model: "", auto: true, prompt: "a door knock", aspect: "16:9", duration: 5 }}
        />,
      ),
    );
    expect(screen.getByTestId("gen-auto").getAttribute("aria-pressed")).toBe("true");
    expect(status()).toBe(t.gen.noSoundLengthAuto);
    expect(press().disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes).toEqual([]);
  });

  it("under Auto, the lengths any model lists are offered and the quote goes to the router", async () => {
    const other: StudioModel = { ...SFX, id: "sfx-two", displayName: "Other Sounds", durations: [3] };
    quoteReply = () => json({ quote: { credits: 3, routed_model: "sfx-two", route_reason: "cheapest" } });
    render(
      withI18n(
        <GeneratePanel orgId={ORG} models={[SFX, other]} desk="voice" initial={{ capability: "sfx", model: "", auto: true, prompt: "a door knock", aspect: "16:9", duration: 3 }} />,
      ),
    );
    const lengths = within(screen.getByRole("group", { name: t.gen.durationLabel })).getAllByRole("button");
    expect(lengths).toHaveLength(5);
    await waitFor(() => expect(quotes.at(-1)).toEqual({ org_id: ORG, capability: "sfx", mode: "auto", params: { prompt: "a door knock", duration_s: 3 } }), { timeout: 2000 });
  });
});

describe("the price is the server's", () => {
  const start = () =>
    render(withI18n(<GeneratePanel orgId={ORG} models={[SFX]} desk="voice" initial={{ capability: "sfx", model: SFX.id, prompt: "a door knock", aspect: "16:9", duration: 5 }} />));

  it("no number is on the key while the quote is pending", async () => {
    quoteReply = () => new Promise<Response>(() => {});
    start();
    await waitFor(() => expect(quotes).toHaveLength(1), { timeout: 2000 });
    const key = screen.getByRole("button", { name: t.gen.quoting }) as HTMLButtonElement;
    expect(key.disabled).toBe(true);
    expect(key.textContent).not.toMatch(/\d/);
  });

  it("an answer without credits is not a price: the key stays unpriced and disabled", async () => {
    quoteReply = () => json({ quote: {} });
    start();
    await waitFor(() => expect(status()).toBe(t.creative.errors.failed), { timeout: 2000 });
    expect(press().disabled).toBe(true);
    expect(press().textContent).not.toMatch(/\d/);
  });
});

describe("each refusal in its own words, with the key disabled", () => {
  const start = (model: StudioModel = SFX) =>
    render(withI18n(<GeneratePanel orgId={ORG} models={[model]} desk="voice" initial={{ capability: "sfx", model: model.id, prompt: "a door knock", aspect: "16:9", duration: 5 }} />));

  it.each([
    ["invalid_params", 400, t.creative.errors.invalid_params],
    ["country_blocked", 451, t.creative.errors.country_blocked],
    ["country_unverified", 451, t.creative.errors.country_unverified],
    ["unpriced", 409, t.creative.errors.unpriced],
    ["adult_attestation_required", 403, t.creative.errors.adult_attestation_required],
  ] as const)("the quote's %s", async (code, http, words) => {
    quoteReply = () => json({ error: code }, http);
    start();
    await waitFor(() => expect(status()).toBe(words), { timeout: 2000 });
    expect(press().disabled).toBe(true);
    expect(press().textContent).not.toMatch(/\d/);
  });

  it("entitlement: a first purchase opens it, with the way to buy", async () => {
    quoteReply = () => json({ error: "entitlement_required", detail: "available after the organization's first credit purchase" }, 403);
    start({ ...SFX, entitlement: "paid" });
    await waitFor(() => expect(screen.getByTestId("gen-locked").getAttribute("data-lock")).toBe("first_purchase"), { timeout: 2000 });
    expect(status()).toContain(t.gen.lockWhy.first_purchase);
    expect(within(screen.getByTestId("gen-locked")).getByRole("link", { name: t.gen.lockBuy })).toBeTruthy();
    expect(press().disabled).toBe(true);
  });

  it("entitlement: a plan-tier model (ElevenLabs SFX's models_audio:basic) is not on sale to any workspace, and is not even quoted", async () => {
    // The lock the server would attach (lib/server/creative withLocks), derived by the same rule rather than written by hand.
    const lock = modelLock("models_audio:basic", true);
    expect(lock).toBe("not_on_sale");
    start({ ...SFX, entitlement: "models_audio:basic", lock });
    expect(screen.getByTestId("gen-locked").textContent).toBe(t.gen.lockWhy.not_on_sale);
    expect(press().disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes).toEqual([]);
  });

  it("entitlement: adults only, until the person confirms their age", async () => {
    start({ ...SFX, adultOnly: true, lock: "adult_only" });
    expect(screen.getByTestId("gen-locked").textContent).toBe(t.gen.lockWhy.adult_only);
    expect(press().disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes).toEqual([]);
  });

  it("short of credits: the key names how many are missing and opens the top-ups instead of pressing", async () => {
    seedCredits(ORG, { balance: 1, reserved: 0, available: 1 });
    start();
    const key = await screen.findByTestId("gen-need-credits", {}, { timeout: 2000 });
    expect(key.tagName).toBe("A");
    expect(key.textContent).toContain(t.gen.needMore.replace(" {n} more", ""));
    expect(status()).toBe(t.gen.needMoreNote);
    expect(creates).toEqual([]);
  });

  it("the database's own insufficient_credits at the press: its words and the way to add credits", async () => {
    createReply = () => json({ error: "insufficient_credits" }, 402);
    start();
    fireEvent.click(await screen.findByRole("button", { name: "Generate · 3 credits" }, { timeout: 2000 }));
    await waitFor(() => expect(status()).toContain(t.creative.errors.insufficient_credits));
    expect(within(document.getElementById("gen-status") as HTMLElement).getByRole("link", { name: t.gen.addCredits }).getAttribute("href")).toBe("/chronos/credits");
  });
});

// ── the words ────────────────────────────────────────────────────────────────

describe("copy", () => {
  const newWords = (d: (typeof dictionaries)[keyof typeof dictionaries]) => [
    d.gen.tabs.sfx,
    d.desk.tools.sfx,
    d.desk.toolFrom.sfx,
    d.gen.promptPh.sfx,
    d.gen.soundWords.sfx,
    d.gen.noSoundLength,
    d.gen.noSoundLengthAuto,
  ];

  it("every language has every new word, and ru and uz are not English left in place", () => {
    for (const [loc, d] of Object.entries(dictionaries)) {
      const words = newWords(d);
      for (const w of words) expect(w.trim(), loc).not.toBe("");
      if (loc !== "en") newWords(dictionaries.en).forEach((en, i) => expect(words[i], `${loc} ${en}`).not.toBe(en));
    }
  });

  it("the feed's name for a sound effect job is the tab's name, and the no-length reason never says clip or another model", () => {
    for (const d of Object.values(dictionaries)) {
      expect(d.gen.kinds.sfx).toBe(d.gen.tabs.sfx);
      expect(d.gen.noSoundLength).toContain("{model}");
      expect(d.gen.noSoundLengthAuto).not.toContain("{model}");
    }
    for (const w of [dictionaries.en.gen.noSoundLength, dictionaries.en.gen.noSoundLengthAuto]) expect(w).not.toMatch(/clip|another model/i);
    for (const w of [dictionaries.ru.gen.noSoundLength, dictionaries.ru.gen.noSoundLengthAuto]) expect(w).not.toMatch(/клип|другую модель/i);
    for (const w of [dictionaries.uz.gen.noSoundLength, dictionaries.uz.gen.noSoundLengthAuto]) expect(w).not.toMatch(/klip|boshqa model/i);
  });

  it("writes Uzbek with the modifier letters (U+02BB, U+02BC), never ' or ’", () => {
    for (const w of newWords(dictionaries.uz)) expect(w).not.toMatch(/['’‘`]/);
    expect(newWords(dictionaries.uz).join(" ")).toMatch(/ʻ/);
  });

  it("names no price, no provider and no plan: those come from the server", () => {
    for (const d of Object.values(dictionaries)) {
      for (const w of newWords(d)) {
        expect(w).not.toMatch(/\d|\$|credit|кредит|kredit/i);
        expect(w).not.toMatch(/google|lyria|elevenlabs|synthid/i);
      }
    }
  });
});
