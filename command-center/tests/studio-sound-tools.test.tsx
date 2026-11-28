// @vitest-environment jsdom
/**
 * The Studio's sound tools: Music (0228: Lyria 3.5, priced per request, instrumental only) and Sound effects. They are built so they go
 * live by themselves the day the database sells a model for them, and until then they say plainly that they are not available yet.
 *
 * What would break without these:
 *  - the music form growing a length, lyrics, a seed, a negative prompt or a loop control that no music model takes (0228 has a
 *    per-request price with no duration, and only instrumental music is offered), so the press is refused after the person filled it;
 *  - a sound effect with no model drawn as a working form, or the Generate key pressable without a reason;
 *  - a price on the key that the server did not quote;
 *  - a refusal (bad settings, a country, no price, a lock, too few credits) shown as a generic failure, or not at all;
 *  - a language missing the new words, or Uzbek written with a typewriter apostrophe;
 *  - the sound tools leaking into the sidebar's tool rows, where they would open a tool nobody can use yet.
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
import { LEGAL_TEXTS } from "@/lib/legal-docs";
import { resetCreditsLive, seedCredits } from "@/lib/credits-live";
import {
  COMPOSER_CAPABILITIES,
  PANEL_CAPABILITIES,
  SOUND_TOOLS,
  WORDS_FREE_PRICE,
  buildParams,
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

const form = (over: Partial<StudioForm>): StudioForm => ({ capability: "music", prompt: "", aspect: "16:9", duration: 5, ...over });

// The real ids, so nothing here passes only for a made-up model. Neither is on sale today; these stand for the day one is.
const LYRIA: StudioModel = { id: "google-lyria-3.5", displayName: "Lyria 3.5", capabilities: ["music"], beta: true };
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
const openTool = (c: "music" | "sfx") => fireEvent.click(screen.getByRole("tab", { name: new RegExp(t.desk.tools[c]) }));
const status = () => document.getElementById("gen-status")?.textContent ?? "";

// ── the request ──────────────────────────────────────────────────────────────

describe("what the sound tools send", () => {
  it("music sends its words and nothing else: no length, lyrics, seed, negative prompt or loop, whatever the form held", () => {
    expect(buildParams(form({ prompt: "  calm piano  ", duration: 30 }))).toEqual({ prompt: "calm piano" });
    // The sheet's stand-in price check is held to the same rule.
    expect(Object.keys(sheetQuoteParams(form({})) ?? {})).toEqual(["prompt"]);
    expect(promptRule("music")).toBe("required");
  });

  it("a sound effect sends its words and the length picked (0228 requires one for sfx)", () => {
    expect(buildParams(form({ capability: "sfx", prompt: "door knock", duration: 2 }))).toEqual({ prompt: "door knock", duration_s: 2 });
    expect(promptRule("sfx")).toBe("required");
  });

  it("both are priced without reading the words (per request, or per second), so the model sheet can price them before typing", () => {
    for (const c of SOUND_TOOLS) expect(WORDS_FREE_PRICE).toContain(c);
  });

  it("the result is a sound, shown with a player like a voice", () => {
    for (const c of SOUND_TOOLS) expect(outputKind(c)).toBe("audio");
  });
});

describe("where the sound tools live", () => {
  it("on the Voice desk, after the speech tools; not in the sidebar's tool rows", () => {
    expect(DESK_TOOLS.voice).toEqual(["tts", "voice_change", "dub", "music", "sfx"]);
    for (const c of SOUND_TOOLS) {
      expect(deskFor(c)).toBe("voice");
      expect(deskFromQuery({ tool: c })).toBe("voice");
      expect(prefillFromQuery(c, undefined)).toMatchObject({ capability: c });
      expect(PANEL_CAPABILITIES as readonly string[]).toContain(c);
      expect(STUDIO_TOOLS as readonly string[]).not.toContain(c);
      expect(COMPOSER_CAPABILITIES as readonly string[]).not.toContain(c);
    }
  });
});

// ── the composer ─────────────────────────────────────────────────────────────

describe("with no model on sale (today)", () => {
  it.each(["sfx", "music"] as const)("%s shows the unavailable state and a disabled key with its reason, and asks nothing", async (c) => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[SPEECH]} desk="voice" />));
    openTool(c);
    expect(screen.getByTestId("gen-no-model").textContent).toBe(t.gen.notAvailableYet);
    expect(status()).toBe(t.gen.notAvailableYet);
    expect(press().disabled).toBe(true);
    // The key's reason is read with it.
    expect(press().getAttribute("aria-describedby")).toContain("gen-status");
    // No length is offered for a model that does not exist, and no music note invites a request.
    expect(screen.queryByRole("group", { name: t.gen.durationLabel })).toBeNull();
    expect(screen.queryByTestId("gen-music-note")).toBeNull();
    fireEvent.change(screen.getByLabelText(new RegExp(t.gen.soundWords[c])), { target: { value: "rain on a tin roof" } });
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes).toEqual([]);
    expect(creates).toEqual([]);
    expect(press().textContent).not.toMatch(/\d/);
  });

  it("no other model is offered in its place: speech is never the music tool's fallback", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[SPEECH]} desk="voice" initial={{ capability: "music", model: "speech", prompt: "", aspect: "16:9", duration: 5 }} />));
    expect(screen.getByRole("tab", { name: new RegExp(t.desk.tools.music) }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("gen-model-name")).toBeNull();
    expect(screen.getByTestId("gen-no-model").textContent).toBe(t.gen.notAvailableYet);
  });
});

describe("the music form, once a model is sold", () => {
  it("has the words and the model, and no length, lyrics, seed, negative prompt or loop control", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[LYRIA]} desk="voice" initial={{ capability: "music", model: LYRIA.id, prompt: "", aspect: "16:9", duration: 5 }} />));
    const words = screen.getByLabelText(t.gen.soundWords.music) as HTMLTextAreaElement;
    expect(words.tagName).toBe("TEXTAREA");
    expect(screen.getByTestId("gen-model-name").textContent).toBe("Lyria 3.5");
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).queryByRole("group", { name: t.gen.durationLabel })).toBeNull();
    expect(within(panel).queryByRole("combobox")).toBeNull();
    expect(panel.querySelectorAll("textarea")).toHaveLength(1);
    expect(panel.querySelectorAll("input")).toHaveLength(0);
    expect(panel.textContent ?? "").not.toMatch(/\b(lyrics? field|seed|negative|loop)\b/i);
    // What it makes, and where the rules for it are written (the existing legal text, never new words here).
    const note = screen.getByTestId("gen-music-note");
    expect(note.textContent).toContain(t.gen.musicNote);
    const links = within(note).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/privacy#processors", "/terms#third-parties"]);

    fireEvent.change(words, { target: { value: "calm solo piano" } });
    const key = await screen.findByRole("button", { name: "Generate · 3 credits" }, { timeout: 2000 });
    expect(quotes.at(-1)).toEqual({ org_id: ORG, capability: "music", model: LYRIA.id, params: { prompt: "calm solo piano" } });
    fireEvent.click(key);
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0]).toMatchObject({ capability: "music", model: LYRIA.id, max_credits: 3, params: { prompt: "calm solo piano" } });
  });

  it("the legal sections it points to exist in every language and name the music model", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const privacy = LEGAL_TEXTS[loc].privacy.sections.find((s) => s.id === "processors");
      const terms = LEGAL_TEXTS[loc].terms.sections.find((s) => s.id === "third-parties");
      expect(JSON.stringify(privacy)).toContain("Lyria");
      expect(JSON.stringify(terms)).toContain("Lyria");
    }
  });
});

describe("the sound effect form, once a model is sold", () => {
  it("offers the model's own lengths and sends the one picked", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[SFX]} desk="voice" initial={{ capability: "sfx", model: SFX.id, prompt: "a door knock", aspect: "16:9", duration: 7 }} />));
    const lengths = within(screen.getByRole("group", { name: t.gen.durationLabel })).getAllByRole("button");
    expect(lengths).toHaveLength(4);
    // 7 s is not on the list: the nearest listed length is sent, and the form says so.
    await screen.findByRole("button", { name: "Generate · 3 credits" }, { timeout: 2000 });
    expect(quotes.at(-1)).toEqual({ org_id: ORG, capability: "sfx", model: SFX.id, params: { prompt: "a door knock", duration_s: 5 } });
    expect(screen.getByTestId("gen-snap-note").textContent).toContain("5 s");
    fireEvent.click(lengths[1]);
    await waitFor(() => expect(quotes.at(-1)?.params).toEqual({ prompt: "a door knock", duration_s: 2 }), { timeout: 2000 });
  });
});

describe("the price is the server's", () => {
  const start = () =>
    render(withI18n(<GeneratePanel orgId={ORG} models={[LYRIA]} desk="voice" initial={{ capability: "music", model: LYRIA.id, prompt: "calm piano", aspect: "16:9", duration: 5 }} />));

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
  const start = (model: StudioModel = LYRIA) =>
    render(withI18n(<GeneratePanel orgId={ORG} models={[model]} desk="voice" initial={{ capability: "music", model: model.id, prompt: "calm piano", aspect: "16:9", duration: 5 }} />));

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
    start({ ...LYRIA, entitlement: "paid" });
    await waitFor(() => expect(screen.getByTestId("gen-locked").getAttribute("data-lock")).toBe("first_purchase"), { timeout: 2000 });
    expect(status()).toContain(t.gen.lockWhy.first_purchase);
    expect(within(screen.getByTestId("gen-locked")).getByRole("link", { name: t.gen.lockBuy })).toBeTruthy();
    expect(press().disabled).toBe(true);
  });

  it("entitlement: a plan-tier model (Lyria's models_audio:premium) is not on sale to any workspace, and is not even quoted", async () => {
    start({ ...LYRIA, entitlement: "models_audio:premium", lock: "not_on_sale" });
    expect(screen.getByTestId("gen-locked").textContent).toBe(t.gen.lockWhy.not_on_sale);
    expect(press().disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes).toEqual([]);
  });

  it("entitlement: adults only, until the person confirms their age", async () => {
    start({ ...LYRIA, adultOnly: true, lock: "adult_only" });
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
    d.gen.tabs.music,
    d.gen.tabs.sfx,
    d.desk.tools.music,
    d.desk.tools.sfx,
    d.desk.toolFrom.music,
    d.desk.toolFrom.sfx,
    d.gen.promptPh.music,
    d.gen.promptPh.sfx,
    d.gen.soundWords.music,
    d.gen.soundWords.sfx,
    d.gen.musicNote,
    d.gen.musicRules,
  ];

  it("every language has every new word, and ru and uz are not English left in place", () => {
    for (const [loc, d] of Object.entries(dictionaries)) {
      const words = newWords(d);
      for (const w of words) expect(w.trim(), loc).not.toBe("");
      if (loc !== "en") newWords(dictionaries.en).forEach((en, i) => expect(words[i], `${loc} ${en}`).not.toBe(en));
    }
  });

  it("writes Uzbek with the modifier letters (U+02BB, U+02BC), never ' or ’", () => {
    for (const w of newWords(dictionaries.uz)) expect(w).not.toMatch(/['’‘`]/);
    expect(newWords(dictionaries.uz).join(" ")).toMatch(/ʻ/);
  });

  it("names no price, no provider and no plan: those come from the server and the legal text", () => {
    for (const d of Object.values(dictionaries)) {
      for (const w of newWords(d)) {
        expect(w).not.toMatch(/\d|\$|credit|кредит|kredit/i);
        expect(w).not.toMatch(/google|lyria|elevenlabs|synthid/i);
      }
    }
  });
});
