// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { NightshiftAiPanel } from "@/components/brain/NightshiftAiPanel";

/**
 * The panel's plan-step states (S1_GAPS G2). What would break without these: a stored outline (no scenes) crashing the list; a
 * minute-long plan shown as a bare "Thinking…"; a failed plan with no way back, or a Retry that reuses the failed press's id (the
 * database would refuse it as a duplicate forever); at 390 px the canvas dock covering the remedy keys.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/chronos/studio" }));

const outline = (title: string) => ({ title, idea: `idea ${title}`, target_seconds: 120, characters: [{ id: "c1" }],
  chapters: [{ id: "ch1", title: "a", seconds: 60, beats: [] }, { id: "ch2", title: "b", seconds: 60, beats: [] }] });
const en = dictionaries.en.aiChat;

let sent: Record<string, unknown>[] = [];
let release: (() => void) | null = null;

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (url.startsWith("/api/brain/session/")) {
      return json(200, { session: { step: "proposing" }, card: null, brief: { version: 1, kind: "short" },
        messages: [{ id: 1, role: "assistant", content: "Pick one", payload: { scenarios: [outline("Alpha"), outline("Beta")] } }] });
    }
    if (url.startsWith("/api/brain/turn")) {
      sent.push(JSON.parse(String(init?.body)));
      await new Promise<void>((r) => { release = r; });
      return json(502, { error: "plan_failed", reason: "vendor_error", step: { window: 2, windows: 2, chapter: 2, chapters: 2 } });
    }
    return json(200, { plan: { used: 0, limit: 30, trial_left: null, max_input_chars: 2000 }, model: "available", canEdit: true, canRun: true, session: { id: "s1" } });
  }));
}

beforeEach(() => {
  sent = [];
  release = null;
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  stubFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mount = () => render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);

describe("Nightshift AI panel: writing the storyboard", () => {
  it("shows stored outlines by their chapters, says the storyboard is being written, and a failed plan offers a fresh Retry", async () => {
    mount();
    await screen.findByText("Alpha");
    expect(screen.getAllByText(en.outlineFacts.replace("{len}", "2 min").replace("{chapters}", "2").replace("{characters}", "1"))).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: en.chooseThisNamed.replace("{title}", "Alpha") }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(screen.getAllByText(en.planWriting).length).toBeGreaterThan(0);
    // The press is remembered while it runs: a refresh waits for it instead of pressing again.
    expect(window.sessionStorage.getItem("nightshift-ai-plan:s1")).toContain(String(sent[0].request_id));
    release!();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(en.errors.plan_failed.replace("{n}", "2").replace("{total}", "2"));
    expect(window.sessionStorage.getItem("nightshift-ai-plan:s1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: en.retry }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ action: "choose", index: 0 });
    expect(sent[1].request_id).not.toBe(sent[0].request_id);
    release!();
  });

  it("keeps every remedy key clear of the canvas's phone dock", async () => {
    const { container } = mount();
    await screen.findByText("Alpha");
    expect(container.querySelector("#ns-ai-body")?.className).toContain("max-[640px]:pb-[calc(env(safe-area-inset-bottom)+172px)]");
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
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
          const json = (s: number, body: unknown) => ({ ok: s < 400, status: s, json: async () => body });
          if (url.startsWith("/api/brain/session/")) return json(200, { session: { step: "asking" }, card: null, brief: null, messages: [] });
          if (url.startsWith("/api/brain/turn")) return json(status, { error: code });
          return json(200, { plan: { used: 0, limit: 30, trial_left: null, max_input_chars: 2000 }, model: "available", canEdit: true, canRun: true, session: { id: "s1" } });
        }));
        const view = render(<I18nProvider locale={locale}><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
        const box = await screen.findByPlaceholderText(a.placeholder);
        fireEvent.change(box, { target: { value: "a film about the sea" } });
        fireEvent.click(screen.getByRole("button", { name: a.send }));
        const alert = await screen.findByRole("alert");
        expect(a.errors[code].length).toBeGreaterThan(20);
        expect(alert.textContent).toContain(a.errors[code]);
        expect(alert.textContent).not.toContain(a.errors.unavailable);
        expect(!!screen.queryByRole("button", { name: a.retry })).toBe(retryable);
        // Uzbek's oʻ and gʻ with U+02BB, never a typed apostrophe.
        if (locale === "uz") expect(a.errors[code]).not.toMatch(/[a-z]['’][a-z]/i);
        view.unmount();
        vi.unstubAllGlobals();
      }
    });
  }
});
