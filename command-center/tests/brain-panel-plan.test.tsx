// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { NightshiftAiPanel } from "@/components/brain/NightshiftAiPanel";
import { CHAT_GATE_REMEDY, type ChatGateError, type ChatGateRemedy, type ChatGateVerdict } from "@/lib/brain/chat-gate";

const SUPPORT = "help@example.test";
vi.mock("@/lib/legal", () => ({ LEGAL: { contactEmail: "help@example.test" } }));

/**
 * The panel's plan-step states (S1_GAPS G2) and the model gate's refusals, in #900's shell. What would break without these: a stored
 * outline (no scenes) crashing the list or reading "scenes: 0"; a minute-long plan shown as a bare "thinking"; a failed plan with no
 * way back, or a Retry that reuses the failed press's id (the database would refuse it as a duplicate forever); a country or age
 * refusal said as "unavailable"; at 390 px the canvas dock covering the remedy keys.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/chronos/studio" }));

const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const outline = (title: string) => ({ title, idea: `idea ${title}`, target_seconds: 120, characters: [{ id: "c1" }], scenes: [],
  chapters: [{ id: "ch1", title: "a", seconds: 60, beats: [] }, { id: "ch2", title: "b", seconds: 60, beats: [] }] });
const en = dictionaries.en.aiChat;

let sent: Record<string, unknown>[] = [];
let release: (() => void) | null = null;
let turnReply: { status: number; body: unknown } = { status: 502, body: {} };
let holdTurn = true;

function stub(proposing: boolean, gate: ChatGateVerdict | null = null, planTurns: { about: number; at_most: number } | null = null) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (url.startsWith("/api/brain/history")) {
      if (/session=/.test(url)) {
        return json(200, proposing
          ? { session: { id: S1, step: "proposing" }, card: null, brief: { version: 1, kind: "short" },
              messages: [{ id: 1, role: "assistant", content: "Pick one", payload: { scenarios: [outline("Alpha"), outline("Beta")].map((o) => (planTurns ? { ...o, plan_turns: planTurns } : o)) } }] }
          : { session: { id: S1, step: "asking" }, card: null, brief: null, messages: [] });
      }
      return json(200, { sessions: [], next_before: null });
    }
    if (url.startsWith("/api/brain/turn")) {
      sent.push(JSON.parse(String(init?.body)));
      if (holdTurn) await new Promise<void>((r) => { release = r; });
      return json(turnReply.status, turnReply.body);
    }
    return json(200, { plan: { used: 0, limit: 30, trial_left: null, max_input_chars: 2000 }, model: "available", canEdit: true, canRun: true,
                       session: proposing ? { id: S1 } : null, gate });
  }));
}

beforeEach(() => {
  sent = [];
  release = null;
  holdTurn = true;
  turnReply = { status: 502, body: { error: "plan_failed", reason: "vendor_error", step: { window: 2, windows: 2, chapter: 2, chapters: 2 } } };
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Nightshift AI panel: writing the storyboard", () => {
  it("shows stored outlines by their chapters, says the storyboard is being written, and a failed plan offers a fresh Retry", async () => {
    stub(true);
    render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
    await screen.findByText("Alpha");
    expect(screen.getAllByText(en.outlineFacts.replace("{len}", "2 min").replace("{chapters}", "2").replace("{characters}", "1"))).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: en.chooseThisNamed.replace("{title}", "Alpha") }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(await screen.findByText(en.planWriting)).toBeTruthy();
    // The press is remembered while it runs: a refresh waits for it instead of pressing again.
    expect(window.sessionStorage.getItem(`nightshift-ai-plan:${S1}`)).toContain(String(sent[0].request_id));
    await act(async () => release!());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(en.errors.plan_failed.replace("{n}", "2").replace("{total}", "2"));
    expect(window.sessionStorage.getItem(`nightshift-ai-plan:${S1}`)).toBeNull();
    // The outlines are still on screen to choose from, after the person's stored choice.
    expect(screen.getByRole("button", { name: en.chooseThisNamed.replace("{title}", "Alpha") })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en.retry }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ action: "choose", index: 0 });
    expect(sent[1].request_id).not.toBe(sent[0].request_id);
    await act(async () => release!());
  });

  it("says before the press how many of today's messages the storyboard uses, as the server counted them", async () => {
    stub(true, null, { about: 3, at_most: 6 });
    render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
    await screen.findByText("Alpha");
    const line = en.planCost.replace("{about}", "3").replace("{limit}", "30").replace("{at_most}", "6").replace("{left}", "30");
    expect(screen.getAllByText(line)).toHaveLength(2);
  });

  it("names on the card the models the server chose for the film", async () => {
    stub(true);
    holdTurn = false;
    turnReply = { status: 200, body: {
      brief: { version: 1, kind: "short", title: "Alpha", idea: "idea Alpha", target_seconds: 120, voice: { mode: "off" }, music: { mode: "off" },
               scenes: [{ id: "s1" }], characters: [], price: { state: "priced", total_credits: 40, spendable: 100, fits: true, shorter: null } },
      film: { id: "film-1", version: 2 },
      quote: { quote_id: "fq-1", total: 40, startable: true, blocked_by: [], refusal: null, exempt: false },
      models: { clip: { id: "minimax-h3", name: "MiniMax H3" }, keyframe: null },
    } };
    render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: en.chooseThisNamed.replace("{title}", "Alpha") }));
    expect(await screen.findByText(en.modelVideo.replace("{name}", "MiniMax H3"))).toBeTruthy();
    // No key-frame model on sale: no line for it, never a guessed name.
    expect(document.querySelector('[data-model="keyframe"]')).toBeNull();
  });

  it("keeps every remedy key clear of the canvas's phone dock", () => {
    const css = readFileSync(join(__dirname, "../components/brain/nightshift-ai-panel.css"), "utf8");
    expect(css).toMatch(/@media \(max-width: 40rem\) \{[^}]*\.ns-ai-dock \{ margin-bottom: calc\(env\(safe-area-inset-bottom\) \+ 172px\); \}/);
  });
});

describe("Nightshift AI panel: the model's gate, worded and keyed by its remedy", () => {
  const CODES = Object.keys(CHAT_GATE_REMEDY) as ChatGateError[];
  const STATUS: Record<ChatGateError, number> = { adult_only_service: 403, adult_attestation_required: 428, age_unavailable: 503, country_blocked: 451, country_unverified: 451 };
  const words = (locale: "en" | "ru" | "uz", r: ChatGateRemedy) => {
    const g = dictionaries[locale].aiChat.gate;
    return r === "contact_support" ? g.contact_support.replace("{email}", SUPPORT) : g[r];
  };
  /** What each remedy offers, and nothing else: a link to confirm the age, Retry, support by mail, or no way on at all. */
  const expectKeys = (locale: "en" | "ru" | "uz", r: ChatGateRemedy) => {
    const a = dictionaries[locale].aiChat;
    expect(!!screen.queryByRole("button", { name: a.retry })).toBe(r === "retry");
    expect(screen.queryByRole("link", { name: a.gate.confirmAge })?.getAttribute("href") ?? null).toBe(r === "confirm_age" ? "/chronos/create" : null);
    expect(screen.queryByRole("link", { name: a.gate.contact })?.getAttribute("href") ?? null).toBe(r === "contact_support" ? `mailto:${SUPPORT}` : null);
  };

  it("every gate code has a remedy, and every remedy its own words in en, ru and uz, never naming the vendor", () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      for (const r of ["confirm_age", "retry", "not_in_region", "contact_support"] as const) {
        expect(words(locale, r).length).toBeGreaterThan(20);
        expect(words(locale, r)).not.toMatch(/google|gemini|anthropic|openai/i);
        // Uzbek's oʻ and gʻ with U+02BB, never a typed apostrophe.
        if (locale === "uz") expect(words(locale, r)).not.toMatch(/[a-z]['’][a-z]/i);
      }
    }
    // #898's mapping, as the panel reads it: country_unverified is a support case, not "not in your region".
    expect(CHAT_GATE_REMEDY.country_unverified).toBe("contact_support");
  });

  for (const code of CODES) {
    const r = CHAT_GATE_REMEDY[code];
    it(`before a press, a ${code} gate closes the box and the choosers and says "${r}" up front`, async () => {
      for (const locale of ["en", "ru", "uz"] as const) {
        sent = [];
        stub(true, { code, remedy: r });
        const view = render(<I18nProvider locale={locale}><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
        await screen.findByText("Alpha");
        const block = document.querySelector(`[data-gate="${code}"]`);
        expect(block?.getAttribute("data-remedy")).toBe(r);
        expect(block?.textContent).toContain(words(locale, r));
        expect((document.getElementById("ns-ai-input") as HTMLTextAreaElement).disabled).toBe(true);
        const choose = screen.getByRole("button", { name: dictionaries[locale].aiChat.chooseThisNamed.replace("{title}", "Alpha") }) as HTMLButtonElement;
        expect(choose.disabled).toBe(true);
        fireEvent.click(choose);
        expectKeys(locale, r);
        expect(sent).toHaveLength(0);
        view.unmount();
        vi.unstubAllGlobals();
      }
    });

    it(`after a press, ${code} is worded by its remedy "${r}", with that remedy's one way on`, async () => {
      for (const locale of ["en", "ru", "uz"] as const) {
        const a = dictionaries[locale].aiChat;
        holdTurn = false;
        turnReply = { status: STATUS[code], body: { error: code } };
        stub(false);
        const view = render(<I18nProvider locale={locale}><NightshiftAiPanel channelId="c1" channelSlug="chronos" fresh /></I18nProvider>);
        await waitFor(() => expect(document.getElementById("ns-ai-input")).not.toBeNull());
        const box = document.getElementById("ns-ai-input") as HTMLTextAreaElement;
        await waitFor(() => expect(box.disabled).toBe(false));
        fireEvent.change(box, { target: { value: "a film about the sea" } });
        await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
        await waitFor(() => expect(document.querySelector(`[data-gate="${code}"]`)).not.toBeNull());
        const block = document.querySelector(`[data-gate="${code}"]`)!;
        expect(block.classList.contains("g5-state")).toBe(true);
        expect(block.getAttribute("data-remedy")).toBe(r);
        expect(block.textContent).toContain(words(locale, r));
        expect(block.textContent).not.toContain(a.errors.unavailable);
        expectKeys(locale, r);
        view.unmount();
        vi.unstubAllGlobals();
      }
    });
  }

  it("a gate of null leaves the box open", async () => {
    stub(true, null);
    render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
    await screen.findByText("Alpha");
    await waitFor(() => expect((document.getElementById("ns-ai-input") as HTMLTextAreaElement).disabled).toBe(false));
    expect(document.querySelector("[data-gate]")).toBeNull();
    expect((screen.getByRole("button", { name: en.chooseThisNamed.replace("{title}", "Alpha") }) as HTMLButtonElement).disabled).toBe(false);
  });
});
