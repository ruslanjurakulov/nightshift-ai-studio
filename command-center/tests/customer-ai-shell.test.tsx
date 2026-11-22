// @vitest-environment jsdom
/**
 * The customer's Nightshift AI in the Studio, drawn in the same shell as the owner's (owner decision 2026-11-21: "the Nightshift AI
 * design is the same for everyone"). What would break without these:
 *  - the customer chat drifting back to its own look (no bare N, no greeting by first name, no pill composer);
 *  - something drawn that does not work: an attach "+", a microphone, a Regenerate the stored conversation cannot honour, or a
 *    rename/delete menu with no 0199 function behind it;
 *  - the history listing or opening anything but this person's own conversations here (only /api/brain/history, scoped by channel);
 *  - a reached daily cap, a plan without the chat, a dead model or a viewer's seat drawn as a usable box, or said without its remedy;
 *  - the side panel's history drawn as a desktop column (no room for the chat), or a drawer that cannot be closed;
 *  - the meter (used of the plan's daily cap, a trial's messages left) lost in the move.
 * Every fetch is mocked.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { NightshiftAiPanel, pairTurns } from "@/components/brain/NightshiftAiPanel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/chronos/studio" }));

const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const S2 = "aaaaaaaa-0000-4000-8000-000000000002";
const en = dictionaries.en.aiChat;

type Reply = { status: number; body: unknown };
const f = {
  plan: { used: 3, limit: 15 as number | null, trial_left: null as number | null, max_input_chars: 2000 },
  model: "available",
  canEdit: true,
  brainStatus: 200,
  brainBody: null as unknown,
  sessions: [] as { id: string; title: string; updated_at: string }[],
  opened: {} as Record<string, Reply>,
  turn: { status: 200, body: { session: { id: S1 }, reply: "Which length?", step: "asking", card: null, scenarios: [] } } as Reply,
  urls: [] as string[],
};

function stub() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    f.urls.push(`${init?.method ?? "GET"} ${url}`);
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (url.startsWith("/api/brain/history")) {
      const m = /session=([0-9a-f-]+)/.exec(url);
      if (m) return json(f.opened[m[1]]?.status ?? 404, f.opened[m[1]]?.body ?? { error: "gone" });
      return json(200, { sessions: f.sessions, next_before: null });
    }
    if (url.startsWith("/api/brain/turn")) return json(f.turn.status, f.turn.body);
    return json(f.brainStatus, f.brainBody ?? { plan: f.plan, model: f.model, canEdit: f.canEdit, canRun: true, session: null });
  }));
}

function mount(locale: Locale = "en", name: string | null = "Aziz") {
  return render(
    <I18nProvider locale={locale}>
      <NightshiftAiPanel channelId="c1" channelSlug="chronos" greetingName={name} fresh />
    </I18nProvider>,
  );
}
const box = () => document.getElementById("ns-ai-input") as HTMLTextAreaElement;
const panel = () => screen.getByTestId("nightshift-ai-panel");

beforeEach(() => {
  f.plan = { used: 3, limit: 15, trial_left: null, max_input_chars: 2000 };
  f.model = "available";
  f.canEdit = true;
  f.brainStatus = 200;
  f.brainBody = null;
  f.sessions = [];
  f.opened = {};
  f.turn = { status: 200, body: { session: { id: S1 }, reply: "Which length?", step: "asking", card: null, scenarios: [] } };
  f.urls = [];
  Element.prototype.scrollIntoView = vi.fn();
  stub();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the shared shell", () => {
  it("greets by first name in Uzbek with the bare N and the pill composer", async () => {
    mount("uz", "Aziz");
    expect(await screen.findByText("Salom, Aziz")).toBeTruthy();
    expect(panel().querySelector(".chat-shell")).not.toBeNull();
    expect(panel().querySelector(".chat-empty-mark")).not.toBeNull();
    expect(panel().querySelector(".chat-pill textarea#ns-ai-input")).not.toBeNull();
  });

  it("says a plain hello with no name, never an address", async () => {
    mount("en", null);
    expect(await screen.findByText(en.shell.greetingNoName)).toBeTruthy();
  });

  it("shows no attach, no microphone and no Regenerate; Copy and the thumbs sit under an answer", async () => {
    mount();
    await waitFor(() => expect(box().disabled).toBe(false));
    fireEvent.change(box(), { target: { value: "A desert heist" } });
    await act(async () => fireEvent.keyDown(box(), { key: "Enter" }));
    expect(await screen.findByText("Which length?")).toBeTruthy();
    expect(screen.getByText("A desert heist").className).toContain("chat-bubble-you");
    for (const name of [en.shell.copy, en.shell.good, en.shell.bad]) expect(screen.getByRole("button", { name })).toBeTruthy();
    const names = screen.getAllByRole("button").map((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").toLowerCase());
    expect(names.some((n) => /regenerat|attach|microphone|voice|^\+$/.test(n))).toBe(false);
    // The answer went through the customer's own route and nowhere else.
    expect(f.urls.filter((u) => u.startsWith("POST"))).toEqual(["POST /api/brain/turn"]);
  });

  it("keeps the meter: today's messages against the plan's cap", async () => {
    mount();
    expect(await screen.findByText("3 of 15 messages today (this workspace)")).toBeTruthy();
  });

  it("keeps a free trial's count and its upgrade link", async () => {
    f.plan = { used: 0, limit: null, trial_left: 2, max_input_chars: 2000 };
    mount();
    expect(await screen.findByText(/Free trial: 2 messages left\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: en.upgrade }).getAttribute("href")).toBe("/chronos/credits#plans");
  });
});

describe("history from 0199", () => {
  it("lists this person's chats here through the scoped route only, with no rename or delete", async () => {
    f.sessions = [{ id: S1, title: "Desert heist", updated_at: new Date().toISOString() }];
    mount();
    const item = await screen.findByRole("button", { name: /Desert heist/ });
    expect(item).toBeTruthy();
    expect(f.urls).toContain("GET /api/brain/history?channel=c1");
    expect(f.urls.every((u) => !u.includes("/api/brain/owner"))).toBe(true);
    expect(screen.queryByRole("button", { name: /Options/ })).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("opens a chat through the same scoped route and draws its stored turns", async () => {
    f.sessions = [{ id: S1, title: "Desert heist", updated_at: new Date().toISOString() }];
    f.opened[S1] = {
      status: 200,
      body: {
        session: { id: S1, step: "asking" }, card: null, brief: null,
        messages: [{ id: 1, role: "user", content: "A desert heist", payload: null }, { id: 2, role: "assistant", content: "How long should it be?", payload: null }],
      },
    };
    mount();
    const item = await screen.findByRole("button", { name: /Desert heist/ });
    await act(async () => fireEvent.click(item));
    expect(await screen.findByText("How long should it be?")).toBeTruthy();
    expect(f.urls).toContain(`GET /api/brain/history?channel=c1&session=${S1}`);
    // The next message continues that chat, not a new one.
    fireEvent.change(box(), { target: { value: "One minute" } });
    await act(async () => fireEvent.keyDown(box(), { key: "Enter" }));
    const call = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.find((c) => c[0] === "/api/brain/turn")!;
    expect(JSON.parse(String(call[1].body))).toMatchObject({ action: "turn", session: S1, text: "One minute" });
  });

  it("drops a chat that is not this person's here any more, with a notice, and opens nothing", async () => {
    f.sessions = [{ id: S2, title: "Old one", updated_at: new Date().toISOString() }];
    mount();
    const item = await screen.findByRole("button", { name: /Old one/ });
    await act(async () => fireEvent.click(item));
    expect(await screen.findByText(en.history.gone)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Old one/ })).toBeNull();
    expect(screen.getByText("Hello, Aziz")).toBeTruthy();
  });
});

describe("caps and refusals, inside the shell, with their remedy", () => {
  it("a reached daily cap: the box is off and the cap says when more open up", async () => {
    f.plan = { used: 15, limit: 15, trial_left: null, max_input_chars: 2000 };
    mount();
    expect(await screen.findByText("Today's Nightshift AI messages for this workspace are used up (15 of 15). More open up within 24 hours.")).toBeTruthy();
    expect(box().disabled).toBe(true);
    expect(box().getAttribute("aria-describedby")).toContain("ns-ai-input-status");
  });

  it("a plan without the chat: the box is off and Upgrade plan leads to the plans", async () => {
    f.plan = { used: 0, limit: null, trial_left: 0, max_input_chars: 2000 };
    mount();
    expect(await screen.findByText(en.planLocked)).toBeTruthy();
    expect(screen.getByRole("link", { name: en.upgrade }).getAttribute("href")).toBe("/chronos/credits#plans");
    expect(box().disabled).toBe(true);
  });

  it("not enabled in this workspace: said, and the box is off", async () => {
    f.brainStatus = 503;
    f.brainBody = { error: "not_enabled" };
    mount();
    expect(await screen.findByText(en.errors.not_enabled)).toBeTruthy();
    expect(box().disabled).toBe(true);
  });

  it("the provider is down: said as unavailable (never which model), and the box is off", async () => {
    f.model = "not_configured";
    mount();
    expect(await screen.findByText(en.errors.assistant_unavailable)).toBeTruthy();
    expect(box().disabled).toBe(true);
    expect(panel().textContent).not.toMatch(/not_configured|claude|gpt|gemini/i);
  });

  it("a viewer's seat: who can use it, and the box is off", async () => {
    f.canEdit = false;
    mount();
    expect(await screen.findByText(en.viewerOnly)).toBeTruthy();
    expect(box().disabled).toBe(true);
  });

  it("an ended sign-in: the way back, not a retry", async () => {
    f.brainStatus = 401;
    mount();
    expect(await screen.findByText(en.errors.session_ended)).toBeTruthy();
    expect(screen.getByRole("link", { name: en.signIn }).getAttribute("href")).toMatch(/^\/login\?next=/);
  });

  it("a cap met mid-turn: said in the thread with no Try again, the words kept, and the box turned off", async () => {
    f.turn = { status: 429, body: { error: "chat_daily_cap", used: 15, limit: 15 } };
    mount();
    await waitFor(() => expect(box().disabled).toBe(false));
    fireEvent.change(box(), { target: { value: "One more" } });
    await act(async () => fireEvent.keyDown(box(), { key: "Enter" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/used up \(15 of 15\)/)).toBeTruthy();
    expect(within(alert).queryByRole("button", { name: en.retry })).toBeNull();
    expect(box().disabled).toBe(true);
    expect(box().value).toBe("One more");
  });

  it("an unavailable answer: Try again sends the same words again, and the answer replaces the notice", async () => {
    f.turn = { status: 502, body: { error: "model_failed", session: { id: S1 } } };
    mount();
    await waitFor(() => expect(box().disabled).toBe(false));
    fireEvent.change(box(), { target: { value: "A heist" } });
    await act(async () => fireEvent.keyDown(box(), { key: "Enter" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(en.errors.assistant_unavailable)).toBeTruthy();
    f.turn = { status: 200, body: { session: { id: S1 }, reply: "Which length?", step: "asking", card: null, scenarios: [] } };
    await act(async () => fireEvent.click(within(alert).getByRole("button", { name: en.retry })));
    expect(await screen.findByText("Which length?")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    const bodies = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
      .filter((c) => c[0] === "/api/brain/turn").map((c) => JSON.parse(String(c[1].body)));
    // The same press both times: a first copy that did land is answered as a duplicate, never stored twice.
    expect(bodies[1].request_id).toBe(bodies[0].request_id);
  });
});

describe("the history drawer in the narrow side panel", () => {
  it("is the drawer at every width: a menu button opens it, and there is no desktop collapse", async () => {
    mount();
    const open = await screen.findByRole("button", { name: en.history.open });
    expect(panel().querySelector(".chat-frame")?.getAttribute("data-variant")).toBe("drawer");
    expect(screen.queryByRole("button", { name: en.history.collapse })).toBeNull();
    fireEvent.click(open);
    expect(screen.getByRole("dialog", { name: en.history.heading }).getAttribute("aria-modal")).toBe("true");
  });

  it("closes on Esc (focus back on its button), on an outside tap, and on a pick", async () => {
    f.sessions = [{ id: S1, title: "Desert heist", updated_at: new Date().toISOString() }];
    f.opened[S1] = { status: 200, body: { session: { id: S1, step: "asking" }, card: null, brief: null, messages: [{ id: 2, role: "assistant", content: "Stored answer", payload: null }] } };
    mount();
    const open = await screen.findByRole("button", { name: en.history.open });
    await screen.findByRole("button", { name: /Desert heist/ });

    fireEvent.click(open);
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(open);

    fireEvent.click(open);
    fireEvent.click(screen.getByTestId("history-scrim"));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(open);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Desert heist/ })));
    expect(screen.queryByRole("dialog")).toBeNull();
    // A stored chat may open with the assistant: no empty bubble of the person's above it.
    expect(await screen.findByText("Stored answer")).toBeTruthy();
    expect(panel().querySelectorAll(".chat-bubble-you")).toHaveLength(0);
  });
});

describe("turns from stored messages", () => {
  const m = (key: string, role: "user" | "assistant", content: string) => ({ key, role, content });
  it("pairs each question with its answer, keeps an assistant-first line, and says so for an unanswered question", () => {
    expect(pairTurns([m("a", "assistant", "Hi"), m("b", "user", "Q1"), m("c", "user", "Q2"), m("d", "assistant", "A2"), m("e", "user", "Q3")], "none")
      .map(({ q, a }) => [q, a])).toEqual([["", "Hi"], ["Q1", "none"], ["Q2", "A2"], ["Q3", "none"]]);
  });
});

describe("strings", () => {
  it("exist in en, ru and uz with the same keys, and Uzbek uses ʻ and ʼ, never an ASCII apostrophe", () => {
    for (const part of ["shell", "history"] as const) {
      const keys = Object.keys(en[part]).sort();
      for (const loc of ["ru", "uz"] as const) expect(Object.keys(dictionaries[loc].aiChat[part]).sort()).toEqual(keys);
    }
    const uz = JSON.stringify([dictionaries.uz.aiChat.shell, dictionaries.uz.aiChat.history, dictionaries.uz.aiChat.errors.session_closed]);
    expect(uz).not.toMatch(/'/);
    expect(uz).toMatch(/ʻ/);
    expect(dictionaries.uz.aiChat.shell.greeting).toBe("Salom, {name}");
  });
});
