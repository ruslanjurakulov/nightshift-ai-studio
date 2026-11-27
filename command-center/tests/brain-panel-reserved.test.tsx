// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { filmStudioStrings } from "@/lib/i18n/film-studio";
import { refusalText } from "@/lib/brain/film-plan-view";
import { NightshiftAiPanel } from "@/components/brain/NightshiftAiPanel";

vi.mock("@/lib/legal", () => ({ LEGAL: { contactEmail: "help@example.test" } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }), usePathname: () => "/chronos/studio" }));

/**
 * Migration 0232's holds as the panel says them: turns a storyboard being written holds are shown as HELD, never as used, with when
 * they come back (minutes), and a turn that only finds the rest held is told so, with Retry and no plans link: buying a plan is not
 * the remedy for a hold that ends within minutes, and "24 hours" would be wrong in every language.
 */

const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const en = dictionaries.en.aiChat;
const UNTIL = "2026-11-27T14:05:00Z";
let plan: Record<string, unknown> = {};
let turnReply: { status: number; body: unknown } = { status: 200, body: {} };

function stub() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (url.startsWith("/api/brain/history")) {
      if (/session=/.test(url)) return json(200, { session: { id: S1, step: "asking" }, card: null, brief: null, messages: [] });
      return json(200, { sessions: [], next_before: null });
    }
    if (url.startsWith("/api/brain/turn")) return json(turnReply.status, turnReply.body);
    return json(200, { plan, model: "available", canEdit: true, canRun: true, session: { id: S1 }, gate: null });
  }));
}

const mount = () => render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);

beforeEach(() => {
  plan = { used: 10, limit: 30, trial_left: null, max_input_chars: 2000, reserved: 0, reserved_until: null };
  turnReply = { status: 200, body: {} };
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("0232's holds in the Nightshift AI panel", () => {
  it("the meter shows the held part beside what is used, never adds it to used", async () => {
    plan = { ...plan, reserved: 7, reserved_until: UNTIL };
    stub();
    const { container } = mount();
    const meter = await vi.waitFor(() => {
      const m = container.querySelector(".chat-meter");
      if (!m?.textContent) throw new Error("no meter yet");
      return m;
    });
    expect(meter.textContent).toContain("10 of 30");
    expect(meter.textContent).toContain("7 more held");
    expect(meter.hasAttribute("data-capped")).toBe(false);
  });

  it("at used + held == limit the meter is capped, and shows no more held than was left", async () => {
    plan = { ...plan, used: 25, reserved: 9, reserved_until: UNTIL };
    stub();
    const { container } = mount();
    const meter = await vi.waitFor(() => {
      const m = container.querySelector(".chat-meter");
      if (!m?.textContent) throw new Error("no meter yet");
      return m;
    });
    expect(meter.hasAttribute("data-capped")).toBe(true);
    expect(meter.textContent).toContain("5 more held");
  });

  it("a turn told chat_reserved says when the hold comes back, keeps Retry, and links to no plans", async () => {
    turnReply = { status: 429, body: { error: "chat_reserved", used: 25, reserved: 5, limit: 30, until: UNTIL } };
    stub();
    mount();
    const box = () => document.getElementById("ns-ai-input") as HTMLTextAreaElement;
    await waitFor(() => expect(box()?.disabled).toBe(false));
    await act(async () => {
      fireEvent.change(box(), { target: { value: "hello there" } });
      fireEvent.submit(box().closest("form") as HTMLFormElement);
    });
    const alert = await screen.findByRole("alert");
    const at = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(Date.parse(UNTIL));
    expect(alert.textContent).toContain(en.errors.chat_reserved.replace("{time}", at));
    expect(screen.queryByRole("link", { name: en.seePlans })).toBeNull();
    expect(screen.queryByRole("link", { name: en.upgrade })).toBeNull();
    expect(screen.queryByRole("button", { name: en.retry })).not.toBeNull();
  });
});

describe("0232's words, in every language", () => {
  it("a hold is never said to come back in 24 hours, in en, ru or uz, in the chat or the film editor", () => {
    for (const lang of ["en", "ru", "uz"] as const) {
      const c = dictionaries[lang].aiChat;
      const w = filmStudioStrings(lang).canvas.ai;
      for (const s of [c.quotaReserved, c.quotaReservedPlain, c.errors.chat_reserved, c.errors.chat_reserved_plain, c.errors.plan_over_cap_trial,
                       w.reserved, w.reservedPlain, w.overCapTrial]) {
        expect(s.length).toBeGreaterThan(20);
        expect(s).not.toMatch(/24/);
      }
      expect(c.errors.chat_reserved).toContain("{time}");
      expect(w.reserved).toContain("{time}");
    }
    // Uzbek letters with their own marks (U+02BB, U+02BC), never an ASCII apostrophe.
    const uz = dictionaries.uz.aiChat;
    expect(`${uz.errors.chat_reserved}${uz.quotaReserved}`).not.toMatch(/'/);
  });

  it("the film editor says chat_reserved with its time and offers Check again; the trial's over-cap has no Check again", () => {
    const w = filmStudioStrings("en").canvas.ai;
    const r = refusalText(w, 429, { error: "chat_reserved", until: UNTIL }, "post");
    expect(r.text).not.toContain("{time}");
    expect(r.check).toBe(true);
    expect(refusalText(w, 429, { error: "chat_reserved", until: null }, "post").text).toBe(w.reservedPlain);
    const t = refusalText(w, 429, { error: "plan_over_cap", needed: 7, left: 2, scope: "trial" }, "post");
    expect(t.text).toBe(w.overCapTrial.replace("{most}", "7").replace("{left}", "2"));
    expect(t.check).toBeUndefined();
  });
});
