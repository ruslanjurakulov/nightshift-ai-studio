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
const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace }), usePathname: () => "/chronos/studio" }));
/** What the next history read says of the plan (0211's lease, lib/server/brain/conversation.ts) and the messages after the proposal. */
const extra = { plan: null as Record<string, unknown> | null, after: [] as { id: number; role: string; content: string }[] };

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
              plan: extra.plan,
              messages: [{ id: 1, role: "assistant", content: "Pick one", payload: { scenarios: [outline("Alpha"), outline("Beta")].map((o) => (planTurns ? { ...o, plan_turns: planTurns } : o)) } }, ...extra.after] }
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
  extra.plan = null;
  extra.after = [];
  replace.mockReset();
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
    const line = en.planCost.replace("{about}", "3").replace("{limit}", "30").replace("{at_most}", "6").replace("{left}", en.messagesLeft.other.replace("{n}", "30"));
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

  it("keeps every remedy key clear of the phone's tab bar; the canvas's dock is never on screen with the chat (a tab of its own)", () => {
    const css = readFileSync(join(__dirname, "../components/brain/nightshift-ai-panel.css"), "utf8");
    expect(css).toMatch(/@media \(max-width: 40rem\) \{[^}]*\.ns-ai-dock \{ margin-bottom: calc\(env\(safe-area-inset-bottom\) \+ 88px\); \}/);
    // Below 1024 px the Studio shows Chat and Plan one at a time (StudioSplit): the canvas, and its fixed dock, sit in the Plan tab.
    const live = readFileSync(join(__dirname, "../components/studio-live/studio-live.css"), "utf8");
    expect(live).toMatch(/\.studio-split\[data-tab="chat"\] > \.studio-split-plan \{ display: none; \}/);
  });
});

describe("Nightshift AI panel: the model's gate, worded and keyed by its remedy", () => {
  // The age refusals are #900's state (its words, no Retry, a link to Create or support); the gate block says the rest.
  const AGE = ["adult_only_service", "adult_attestation_required"] as const;
  type AgeCode = (typeof AGE)[number];
  const CODES = (Object.keys(CHAT_GATE_REMEDY) as ChatGateError[]).filter((k) => !(AGE as readonly string[]).includes(k));
  const STATUS: Record<ChatGateError, number> = { adult_only_service: 403, adult_attestation_required: 428, age_unavailable: 503, country_blocked: 451, country_unverified: 451 };
  type GateRemedy = Exclude<ChatGateRemedy, "confirm_age">;
  const words = (locale: "en" | "ru" | "uz", r: GateRemedy) => {
    const g = dictionaries[locale].aiChat.gate;
    return r === "contact_support" ? g.contact_support.replace("{email}", SUPPORT) : g[r];
  };
  /** What each remedy offers, and nothing else: Retry, support by mail, or no way on at all. */
  const expectKeys = (locale: "en" | "ru" | "uz", r: GateRemedy) => {
    const a = dictionaries[locale].aiChat;
    expect(!!screen.queryByRole("button", { name: a.retry })).toBe(r === "retry");
    expect(screen.queryByRole("link", { name: a.gate.contact })?.getAttribute("href") ?? null).toBe(r === "contact_support" ? `mailto:${SUPPORT}` : null);
  };
  /** #900's age state: its words, its one link, no Retry. */
  const ageOf = (locale: "en" | "ru" | "uz", code: AgeCode) => {
    const d = dictionaries[locale];
    return code === "adult_attestation_required"
      ? { text: d.aiChat.errors.adult_attestation_required, link: d.aiChat.confirmAge, href: "/chronos/create" }
      : { text: d.aiChat.errors.adult_only_service, link: d.age.contact, href: `mailto:${SUPPORT}` };
  };
  const expectAgeOnce = (locale: "en" | "ru" | "uz", code: AgeCode) => {
    const a = ageOf(locale, code);
    // Said once: one block, one copy of the words, one link, and no gate block beside it.
    expect(document.querySelectorAll(`[data-problem="${code}"]`)).toHaveLength(1);
    expect(screen.getAllByText(a.text)).toHaveLength(1);
    expect(document.querySelector("[data-gate]")).toBeNull();
    const links = screen.getAllByRole("link", { name: a.link });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe(a.href);
    expect(screen.queryByRole("button", { name: dictionaries[locale].aiChat.retry })).toBeNull();
  };

  it("every non-age remedy has its own words in en, ru and uz, never naming the vendor", () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      for (const r of ["retry", "not_in_region", "contact_support"] as const) {
        expect(words(locale, r).length).toBeGreaterThan(20);
        expect(words(locale, r)).not.toMatch(/google|gemini|anthropic|openai/i);
        // Uzbek's oʻ and gʻ with U+02BB, never a typed apostrophe.
        if (locale === "uz") expect(words(locale, r)).not.toMatch(/[a-z]['’][a-z]/i);
      }
    }
    // #898's mapping, as the panel reads it: country_unverified is a support case, not "not in your region".
    expect(CHAT_GATE_REMEDY.country_unverified).toBe("contact_support");
  });

  for (const code of AGE) {
    it(`before a press, a ${code} gate is #900's age state, said once, with no Retry`, async () => {
      for (const locale of ["en", "ru", "uz"] as const) {
        sent = [];
        stub(true, { code, remedy: CHAT_GATE_REMEDY[code] });
        const view = render(<I18nProvider locale={locale}><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
        await screen.findByText("Alpha");
        await waitFor(() => expect(document.querySelector(`[data-problem="${code}"]`)).not.toBeNull());
        expectAgeOnce(locale, code);
        expect((document.getElementById("ns-ai-input") as HTMLTextAreaElement).disabled).toBe(true);
        expect(sent).toHaveLength(0);
        view.unmount();
        vi.unstubAllGlobals();
      }
    });

    it(`after a press, ${code} is #900's age state, said once, with no Retry`, async () => {
      for (const locale of ["en", "ru", "uz"] as const) {
        holdTurn = false;
        turnReply = { status: STATUS[code], body: { error: code } };
        stub(false);
        const view = render(<I18nProvider locale={locale}><NightshiftAiPanel channelId="c1" channelSlug="chronos" fresh /></I18nProvider>);
        await waitFor(() => expect(document.getElementById("ns-ai-input")).not.toBeNull());
        const box = document.getElementById("ns-ai-input") as HTMLTextAreaElement;
        await waitFor(() => expect(box.disabled).toBe(false));
        fireEvent.change(box, { target: { value: "a film about the sea" } });
        await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
        await waitFor(() => expect(document.querySelector(`[data-problem="${code}"]`)).not.toBeNull());
        expectAgeOnce(locale, code);
        view.unmount();
        vi.unstubAllGlobals();
      }
    });
  }

  for (const code of CODES) {
    const r = CHAT_GATE_REMEDY[code] as GateRemedy;
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

describe("Nightshift AI panel: the plan's lease (0211), followed across tabs and refreshes", () => {
  const mountProposal = () => {
    stub(true);
    return render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
  };

  it("a running plan (another tab, a refresh) is waited on: its own words as the status, the choosers closed, nothing posted", async () => {
    extra.plan = { state: "running", reason: null, expires_at: new Date(Date.now() + 200_000).toISOString(), scenario_index: 0 };
    mountProposal();
    expect(await screen.findByText(en.errors.plan_running)).toBeTruthy();
    expect((screen.getByRole("button", { name: en.chooseThisNamed.replace("{title}", "Alpha") }) as HTMLButtonElement).disabled).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("a plan that failed while this tab was away is said at once, with Retry", async () => {
    extra.plan = { state: "failed", reason: "vendor_error", expires_at: new Date().toISOString(), scenario_index: 0 };
    mountProposal();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(en.errors.plan_failed_plain);
    expect(screen.getByRole("button", { name: en.retry })).toBeTruthy();
  });

  it("an older proposal's failed plan is not news once new scenarios are on screen", async () => {
    // The proposal on screen is message 1; the lease planned proposal 0 (an earlier one).
    extra.plan = { state: "failed", reason: "vendor_error", expires_at: new Date().toISOString(), scenario_index: 0, proposal_id: 0 };
    mountProposal();
    await screen.findByText("Alpha");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("L7: a failure no new attempt can change offers no Retry", async () => {
    for (const reason of ["not_plannable", "vendor_auth", "not_configured"]) {
      extra.plan = { state: "failed", reason, expires_at: new Date().toISOString(), scenario_index: 0 };
      const view = mountProposal();
      await screen.findByRole("alert");
      expect(screen.queryByRole("button", { name: en.retry }), reason).toBeNull();
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("M5: the stored choice of an outline is drawn once, never as a question with no saved answer", async () => {
    extra.after = [{ id: 2, role: "user", content: "Alpha" }];
    mountProposal();
    await screen.findAllByText("Alpha");
    expect(screen.queryByText(en.history.noAnswer)).toBeNull();
  });

  it("+ New takes ?brain= off through the router (the canvas follows), never a history.replaceState it cannot see", async () => {
    window.history.replaceState(null, "", `/chronos/studio?brain=${S1}`);
    mountProposal();
    await screen.findByText("Alpha");
    fireEvent.click(screen.getAllByRole("button", { name: en.shell.newChat })[0]);
    expect(replace).toHaveBeenCalledWith("/chronos/studio", { scroll: false });
    window.history.replaceState(null, "", "/");
  });
});

describe("Nightshift AI panel: fix round 2 (Lens and Pixel)", () => {
  const chooseAlpha = () => screen.getByRole("button", { name: en.chooseThisNamed.replace("{title}", "Alpha") });
  const pressAlpha = async (reply: { status: number; body: unknown }) => {
    holdTurn = false;
    turnReply = reply;
    stub(true);
    render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
    await screen.findByText("Alpha");
    await act(async () => fireEvent.click(chooseAlpha()));
    return screen.findByRole("alert");
  };

  it("plan_unavailable offers \"Check again\", which asks again with a fresh press (Pixel P6)", async () => {
    const alert = await pressAlpha({ status: 503, body: { error: "plan_unavailable" } });
    expect(alert.textContent).toContain(en.errors.plan_unavailable);
    expect(screen.queryByRole("button", { name: en.retry })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: en.checkAgain })));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ action: "choose", index: 0 });
  });

  it("plan_over_cap on the workspace's cap leads to the plans (Pixel minor)", async () => {
    const alert = await pressAlpha({ status: 429, body: { error: "plan_over_cap", needed: 8, about: 4, left: 2 } });
    expect(alert.textContent).not.toContain(en.errors.plan_over_cap_person);
    expect(screen.getByRole("link", { name: en.seePlans }).getAttribute("href")).toBe("/chronos/credits#plans");
    expect(screen.queryByRole("button", { name: en.retry })).toBeNull();
  });

  it("plan_over_cap on the person's own cap says so and offers no plans, which cannot raise it (Lens round 3)", async () => {
    const alert = await pressAlpha({ status: 429, body: { error: "plan_over_cap", needed: 8, about: 4, left: 2, scope: "person" } });
    expect(alert.textContent).toContain(en.errors.plan_over_cap_person);
    expect(screen.queryByRole("link", { name: en.seePlans })).toBeNull();
    expect(screen.queryByRole("button", { name: en.retry })).toBeNull();
  });

  it("plan_superseded says no credits were charged and opens the project, with no Retry", async () => {
    const alert = await pressAlpha({ status: 409, body: { error: "plan_superseded", film_id: "f-1" } });
    expect(alert.textContent).toContain(en.errors.plan_superseded);
    expect(en.errors.plan_superseded).toMatch(/No credits were charged/);
    expect(en.errors.plan_superseded).not.toMatch(/choose again/i);
    expect(screen.getByRole("link", { name: en.openProject }).getAttribute("href")).toBe("/chronos/create/projects/f-1");
    expect(screen.queryByRole("button", { name: en.retry })).toBeNull();
  });

  for (const reason of ["content_refused", "plan_over_cap", "plan_superseded"]) {
    it(`a plan that failed as ${reason} while this tab was away offers no Retry (Lens L1)`, async () => {
      extra.plan = { state: "failed", reason, expires_at: new Date().toISOString(), scenario_index: 0 };
      stub(true);
      render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
      await screen.findByRole("alert");
      expect(screen.queryByRole("button", { name: en.retry })).toBeNull();
    });
  }

  it("a turn the model's gate refused closes the box, as the same gate before a press does (Pixel minor)", async () => {
    holdTurn = false;
    turnReply = { status: 451, body: { error: "country_blocked" } };
    stub(false);
    render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" fresh /></I18nProvider>);
    const input = () => document.getElementById("ns-ai-input") as HTMLTextAreaElement | null;
    await waitFor(() => expect(input()?.disabled).toBe(false));
    const box = input()!;
    fireEvent.change(box, { target: { value: "a film about the sea" } });
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await waitFor(() => expect(document.querySelector('[data-gate="country_blocked"]')).not.toBeNull());
    expect((document.getElementById("ns-ai-input") as HTMLTextAreaElement).disabled).toBe(true);
    // Said once: the refusal's block, not a second one from the gate.
    expect(document.querySelectorAll("[data-gate]")).toHaveLength(1);
  });

  it("a gate refusal whose remedy is retry leaves the box open, so a Retry that succeeds is not stuck behind it (Lens round 3)", async () => {
    holdTurn = false;
    turnReply = { status: 503, body: { error: "age_unavailable" } };
    stub(false);
    render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" fresh /></I18nProvider>);
    const input = () => document.getElementById("ns-ai-input") as HTMLTextAreaElement | null;
    await waitFor(() => expect(input()?.disabled).toBe(false));
    fireEvent.change(input()!, { target: { value: "a film about the sea" } });
    await act(async () => fireEvent.keyDown(input()!, { key: "Enter" }));
    await waitFor(() => expect(screen.getByRole("button", { name: en.retry })).toBeTruthy());
    turnReply = { status: 200, body: { reply: "Which kind?", step: "asking", card: null, session: { id: S1 } } };
    await act(async () => fireEvent.click(screen.getByRole("button", { name: en.retry })));
    await waitFor(() => expect(screen.queryByRole("button", { name: en.retry })).toBeNull());
    expect(document.querySelector("[data-gate]")).toBeNull();
    expect(input()?.disabled).toBe(false);
  });

  it("a short film's card shows one price, Create's, and a long one keeps its own (Pixel P3)", async () => {
    holdTurn = false;
    turnReply = { status: 200, body: {
      brief: { version: 1, kind: "short", title: "Alpha", idea: "idea Alpha", target_seconds: 120, voice: { mode: "off" }, music: { mode: "off" },
               scenes: [{ id: "s1" }], characters: [], price: { state: "priced", total_credits: 1240, spendable: 5000, fits: true, shorter: null } },
      film: { id: "film-1", version: 2 }, models: { clip: null, keyframe: null },
      film_quote: { priced: true, total: 1240, quote_id: `fq-2-${"a".repeat(32)}`, startable: true, may_start: true, available: 5000 },
    } };
    stub(true);
    render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
    await screen.findByText("Alpha");
    await act(async () => fireEvent.click(chooseAlpha()));
    const card = await screen.findByRole("region", { name: en.planReady });
    // The card's own header line would read "1,240 credits"; only Create says the price now.
    expect(card.textContent).not.toMatch(/1[,  ]?240 credits/);
  });

  it("an answer picked from a card by keyboard gives focus back to the box, never to <body> (Pixel P5)", async () => {
    holdTurn = false;
    turnReply = { status: 200, body: { reply: "Next", step: "asking", card: null, session: { id: S1 } } };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
      if (url.startsWith("/api/brain/history")) {
        if (/session=/.test(url)) {
          return json(200, { session: { id: S1, step: "asking" }, brief: null,
            card: { id: "k1", slot: "kind", question: "Which kind?", options: ["Short", "Long"], thread_title: null },
            messages: [{ id: 1, role: "assistant", content: "Which kind?", payload: null }] });
        }
        return json(200, { sessions: [], next_before: null });
      }
      if (url.startsWith("/api/brain/turn")) { sent.push(JSON.parse(String(init?.body))); return json(turnReply.status, turnReply.body); }
      return json(200, { plan: { used: 0, limit: 30, trial_left: null, max_input_chars: 2000 }, model: "available", canEdit: true, canRun: true,
                         session: { id: S1 }, gate: null });
    }));
    render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
    const option = await screen.findByRole("button", { name: /Short/ });
    option.focus();
    await act(async () => { fireEvent.click(option); });
    await waitFor(() => expect(sent).toHaveLength(1));
    await waitFor(() => expect(document.activeElement?.id).toBe("ns-ai-input"));
  });
});

describe("Nightshift AI panel: a film with no model set is fixed in its project (S2's fixHref)", () => {
  it("model_not_set: S2's Create links to the project as its primary key, Check again beside it, and no link of the panel's own", async () => {
    holdTurn = false;
    turnReply = { status: 200, body: {
      brief: { version: 1, kind: "short", title: "Alpha", idea: "idea Alpha", target_seconds: 120, voice: { mode: "off" }, music: { mode: "off" },
               scenes: [{ id: "s1" }], characters: [], price: { state: "unpriced" } },
      film: { id: "film-9", version: 2 }, models: { clip: null, keyframe: null },
      film_quote: { priced: false, total: null, quote_id: null, startable: false, may_start: true, available: 500, blocked_by: [],
                    refusals: [{ reason: "model_not_set" }] },
    } };
    stub(true);
    render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
    await screen.findByText("Alpha");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: en.chooseThisNamed.replace("{title}", "Alpha") })));
    const k = dictionaries.en.studioTimeline.create;
    const fix = await screen.findByRole("link", { name: k.openToFix });
    expect(fix.getAttribute("href")).toBe("/chronos/create/projects/film-9");
    expect(fix.hasAttribute("data-primary")).toBe(true);
    expect(screen.getByRole("button", { name: k.checkAgain })).toBeTruthy();
    expect(document.querySelector('[data-testid="ns-ai-open-project"]')).toBeNull();
    expect(screen.queryByRole("link", { name: en.openProject })).toBeNull();
  });
});

describe("Nightshift AI panel: what it tells the canvas (S3, Atlas 28 Nov)", () => {
  it('a first send that makes no session ends as {session_id: null, phase: "end", reason: "failed"}, never as "planning" forever', async () => {
    stub(false);
    holdTurn = false;
    turnReply = { status: 502, body: { error: "unavailable" } };
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("nightshift:brain-activity", on);
    try {
      render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" fresh /></I18nProvider>);
      const input = () => document.getElementById("ns-ai-input") as HTMLTextAreaElement | null;
      await waitFor(() => expect(input()?.disabled).toBe(false));
      const box = input()!;
      fireEvent.change(box, { target: { value: "A girl and a kite" } });
      await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
      await waitFor(() => expect(sent).toHaveLength(1));
      await waitFor(() => expect(seen).toContainEqual({ session_id: null, phase: "end", reason: "failed" }));
      expect(seen[0]).toEqual({ session_id: null, phase: "thinking" });
    } finally {
      window.removeEventListener("nightshift:brain-activity", on);
    }
  });
});
