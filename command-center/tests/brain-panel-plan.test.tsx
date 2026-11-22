// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { NightshiftAiPanel } from "@/components/brain/NightshiftAiPanel";

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

function stub(proposing: boolean) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (url.startsWith("/api/brain/history")) {
      if (/session=/.test(url)) {
        return json(200, proposing
          ? { session: { id: S1, step: "proposing" }, card: null, brief: { version: 1, kind: "short" },
              messages: [{ id: 1, role: "assistant", content: "Pick one", payload: { scenarios: [outline("Alpha"), outline("Beta")] } }] }
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
                       session: proposing ? { id: S1 } : null });
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

  it("keeps every remedy key clear of the canvas's phone dock", () => {
    const css = readFileSync(join(__dirname, "../components/brain/nightshift-ai-panel.css"), "utf8");
    expect(css).toMatch(/@media \(max-width: 40rem\) \{[^}]*\.ns-ai-dock \{ margin-bottom: calc\(env\(safe-area-inset-bottom\) \+ 172px\); \}/);
  });
});

describe("Nightshift AI panel: the model's own conditions, each with its remedy", () => {
  const cases = [
    ["country_blocked", 451, false],
    ["country_unverified", 451, false],
    ["adult_attestation_required", 428, false],
    ["age_unavailable", 503, true],
  ] as const;
  for (const [code, status, retryable] of cases) {
    it(`${code} is said in its own words in en, ru and uz, never "unavailable"`, async () => {
      for (const locale of ["en", "ru", "uz"] as const) {
        const a = dictionaries[locale].aiChat;
        holdTurn = false;
        turnReply = { status, body: { error: code } };
        stub(false);
        const view = render(<I18nProvider locale={locale}><NightshiftAiPanel channelId="c1" channelSlug="chronos" fresh /></I18nProvider>);
        await waitFor(() => expect(document.getElementById("ns-ai-input")).not.toBeNull());
        const box = document.getElementById("ns-ai-input") as HTMLTextAreaElement;
        await waitFor(() => expect(box.disabled).toBe(false));
        fireEvent.change(box, { target: { value: "a film about the sea" } });
        await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
        const alert = await screen.findByRole("alert");
        expect(a.errors[code].length).toBeGreaterThan(20);
        expect(alert.textContent).toContain(a.errors[code]);
        expect(alert.textContent).not.toContain(a.errors.unavailable);
        expect(!!screen.queryByRole("button", { name: a.retry })).toBe(retryable);
        // S5's shared state, not the generic problem box.
        expect(alert.classList.contains("g5-state")).toBe(true);
        expect(alert.getAttribute("data-gate")).toBe(code);
        // Only the age confirmation links somewhere: Create's 18+ box (0192).
        const link = screen.queryByRole("link", { name: a.errors.confirmAge });
        expect(link?.getAttribute("href") ?? null).toBe(code === "adult_attestation_required" ? "/chronos/create" : null);
        // Neutral: the region is never said with a vendor's name, and never by a country name the server did not send.
        expect(a.errors[code]).not.toMatch(/google|gemini|anthropic|openai/i);
        // Uzbek's oʻ and gʻ with U+02BB, never a typed apostrophe.
        if (locale === "uz") expect(a.errors[code]).not.toMatch(/[a-z]['’][a-z]/i);
        view.unmount();
        vi.unstubAllGlobals();
      }
    });
  }
});
