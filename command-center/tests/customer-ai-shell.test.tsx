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
 *  - the meter (used of the plan's daily cap, a trial's messages left) lost in the move;
 *  - a conversation that could not be read dropped silently (an empty chat with no reason and no Retry), or the words of a press
 *    that was stored but not shown cleared from the box;
 *  - a pick from the history while an answer is on its way taken as opened, when nothing was;
 *  - a gone ?brain= left on the URL, so the canvas draws a conversation the panel is not showing;
 *  - a refusal no retry can change (403, 400) told to "try again".
 * Every fetch is mocked.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { NightshiftAiPanel, pairTurns } from "@/components/brain/NightshiftAiPanel";
import { useBrainBrief } from "@/components/studio-live/useBrainBrief";

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: nav.replace }), usePathname: () => "/chronos/studio" }));

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
  /** While set, a turn's answer waits for it. */
  hold: null as Promise<void> | null,
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
    if (url.startsWith("/api/brain/turn")) {
      if (f.hold) await f.hold;
      return json(f.turn.status, f.turn.body);
    }
    return json(f.brainStatus, f.brainBody ?? { plan: f.plan, model: f.model, canEdit: f.canEdit, canRun: true, session: null });
  }));
}

function mount(locale: Locale = "en", name: string | null = "Aziz", initialSession: string | null = null) {
  return render(
    <I18nProvider locale={locale}>
      <NightshiftAiPanel channelId="c1" channelSlug="chronos" greetingName={name} initialSession={initialSession} fresh={!initialSession} />
    </I18nProvider>,
  );
}
const stored = (text: string): Reply => ({
  status: 200,
  body: { session: { id: S1, step: "asking" }, card: null, brief: null, messages: [{ id: 1, role: "user", content: "A heist", payload: null }, { id: 2, role: "assistant", content: text, payload: null }] },
});
const turnCalls = () => (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.filter((c) => c[0] === "/api/brain/turn");
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
  f.hold = null;
  nav.replace.mockReset();
  window.history.replaceState(null, "", "/chronos/studio");
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

describe("a conversation that could not be read", () => {
  it("the panel's ?brain= conversation answers 503: the problem and a Retry, which opens it", async () => {
    f.opened[S1] = { status: 503, body: { error: "unavailable" } };
    mount("en", "Aziz", S1);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(en.history.failed)).toBeTruthy();
    f.opened[S1] = stored("How long should it be?");
    await act(async () => fireEvent.click(within(alert).getByRole("button", { name: en.retry })));
    expect(await screen.findByText("How long should it be?")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a duplicate press whose conversation answers 503: the words stay in the box, and Retry reads it without sending them again", async () => {
    f.turn = { status: 409, body: { error: "duplicate_request", session: { id: S1 } } };
    f.opened[S1] = { status: 503, body: { error: "unavailable" } };
    mount();
    await waitFor(() => expect(box().disabled).toBe(false));
    fireEvent.change(box(), { target: { value: "A heist" } });
    await act(async () => fireEvent.keyDown(box(), { key: "Enter" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(en.history.failed)).toBeTruthy();
    expect(box().value).toBe("A heist");
    f.opened[S1] = stored("Which length?");
    await act(async () => fireEvent.click(within(alert).getByRole("button", { name: en.retry })));
    expect(await screen.findByText("Which length?")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(turnCalls()).toHaveLength(1);
  });

  it("a refusal a retry cannot change (403) is said without \"try again\" and offers no Retry", async () => {
    f.opened[S1] = { status: 403, body: { error: "forbidden" } };
    mount("en", "Aziz", S1);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(en.history.forbidden)).toBeTruthy();
    expect(within(alert).queryByRole("button", { name: en.retry })).toBeNull();
  });

  it("each refusal from the history has its own words, and only a passing failure says to try again", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const h = dictionaries[loc].aiChat.history;
      const words = new Set([h.forbidden, h.badRequest, h.notHere, h.busy, h.failed, h.gone]);
      expect(words.size).toBe(6);
    }
    for (const k of ["forbidden", "badRequest", "notHere", "busy"] as const) expect(en.history[k]).not.toMatch(/try again/i);
  });

  it("opening from the list: 403 and 400 each say their own reason, never \"try again\"", async () => {
    f.sessions = [{ id: S1, title: "Desert heist", updated_at: new Date().toISOString() }, { id: S2, title: "Night train", updated_at: new Date().toISOString() }];
    f.opened[S1] = { status: 403, body: { error: "forbidden" } };
    f.opened[S2] = { status: 400, body: { error: "bad_request" } };
    mount();
    const first = await screen.findByRole("button", { name: /Desert heist/ });
    await act(async () => fireEvent.click(first));
    expect(await screen.findByText(en.history.forbidden)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Night train/ })));
    expect(await screen.findByText(en.history.badRequest)).toBeTruthy();
    expect(screen.queryByText(/try again/i)).toBeNull();
    // Neither was dropped from the list: only "gone" removes a row.
    expect(screen.getByRole("button", { name: /Desert heist/ })).toBeTruthy();
  });
});

describe("a pick from the history while an answer is on its way", () => {
  it("is refused and said, and nothing is opened", async () => {
    f.sessions = [{ id: S1, title: "Desert heist", updated_at: new Date().toISOString() }];
    f.opened[S1] = stored("Stored answer");
    let release = () => {};
    f.hold = new Promise<void>((r) => { release = r; });
    mount();
    const item = await screen.findByRole("button", { name: /Desert heist/ });
    await waitFor(() => expect(box().disabled).toBe(false));
    fireEvent.change(box(), { target: { value: "A heist" } });
    // The send and the pick land before React draws the busy state, so the row is still enabled when it is pressed.
    await act(async () => {
      fireEvent.keyDown(box(), { key: "Enter" });
      fireEvent.click(item);
    });
    expect(await screen.findByText(en.history.busy)).toBeTruthy();
    expect(f.urls.some((u) => u.includes(`session=${S1}`))).toBe(false);
    expect(screen.queryByText("Stored answer")).toBeNull();
    await act(async () => release());
    expect(await screen.findByText("Which length?")).toBeTruthy();
  });
});

describe("a ?brain= conversation that is gone", () => {
  it("is taken off the URL with a router replace (no new history entry), and a new chat is shown", async () => {
    window.history.replaceState(null, "", `/chronos/studio?view=live&brain=${S2}`);
    const view = mount("en", "Aziz", S2);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(1));
    expect(nav.replace).toHaveBeenCalledWith("/chronos/studio?view=live", { scroll: false });
    expect(screen.getByText("Hello, Aziz")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    // The page comes back without ?brain=: that is the panel's own doing, not a reason to read again and open the latest chat.
    const reads = () => f.urls.filter((u) => u.startsWith("GET /api/brain?")).length;
    expect(reads()).toBe(1);
    view.rerender(
      <I18nProvider locale="en">
        <NightshiftAiPanel channelId="c1" channelSlug="chronos" greetingName="Aziz" initialSession={null} fresh={false} />
      </I18nProvider>,
    );
    await act(async () => {});
    expect(reads()).toBe(1);
  });

  it("the canvas draws nothing of it once ?brain= is gone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: "not_found" }) })));
    const { result, rerender } = renderHook(({ s }: { s: string | null }) => useBrainBrief(s), { initialProps: { s: S2 as string | null } });
    await waitFor(() => expect(result.current.load.state).toBe("notFound"));
    rerender({ s: null });
    expect(result.current.load.state).toBe("loading");
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

describe("Pixel on #900: every state has its remedy, and focus is never dropped", () => {
  it("a pick from the drawer puts focus back on the button that opened it, never on <body>", async () => {
    f.sessions = [{ id: S1, title: "Desert heist", updated_at: new Date().toISOString() }];
    f.opened[S1] = stored("Stored answer");
    mount();
    const open = await screen.findByRole("button", { name: en.history.open });
    await screen.findByRole("button", { name: /Desert heist/ });
    fireEvent.click(open);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Desert heist/ })));
    expect(await screen.findByText("Stored answer")).toBeTruthy();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(open);
  });

  it("a truncated history title is available in full", async () => {
    const long = "A very long title for a desert heist film that cannot fit in the narrow drawer";
    f.sessions = [{ id: S1, title: long, updated_at: new Date().toISOString() }];
    mount();
    const item = await screen.findByRole("button", { name: new RegExp(long) });
    expect(item.querySelector(".chat-history-title")?.getAttribute("title")).toBe(long);
  });

  it("a list that failed says the list's own words (history.error), not the words for a chat that would not open", async () => {
    stub();
    const base = fetch as unknown as (url: string, init?: RequestInit) => Promise<unknown>;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/brain/history") && !url.includes("session=")) return { ok: false, status: 503, json: async () => ({ error: "unavailable" }) };
      return base(url, init);
    }));
    mount();
    expect(await screen.findByText(en.history.error)).toBeTruthy();
    expect(screen.queryByText(en.history.failed)).toBeNull();
    expect(screen.getByRole("button", { name: en.history.retry })).toBeTruthy();
  });

  it("the 18+ refusal offers no Retry that cannot work, and says where the age is answered", async () => {
    f.turn = { status: 403, body: { error: "adult_only_service" } };
    mount();
    await waitFor(() => expect(box().disabled).toBe(false));
    fireEvent.change(box(), { target: { value: "A heist" } });
    await act(async () => fireEvent.keyDown(box(), { key: "Enter" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(en.errors.adult_only_service);
    expect(within(alert).queryByRole("button", { name: en.retry })).toBeNull();
    // No support address configured in tests: the words say where to write instead of a link to nowhere.
    expect(alert.textContent).toContain(dictionaries.en.age.contactNoEmail);
  });

  it("an age not yet confirmed: no Retry, and a link to Create, where the 18+ question is asked", async () => {
    f.turn = { status: 428, body: { error: "adult_attestation_required" } };
    mount();
    await waitFor(() => expect(box().disabled).toBe(false));
    fireEvent.change(box(), { target: { value: "A heist" } });
    await act(async () => fireEvent.keyDown(box(), { key: "Enter" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(en.errors.adult_attestation_required)).toBeTruthy();
    expect(within(alert).queryByRole("button", { name: en.retry })).toBeNull();
    expect(within(alert).getByRole("link", { name: en.confirmAge }).getAttribute("href")).toBe("/chronos/create");
  });

  it("a cap met mid-turn leads to the plans, with no reset time the server did not give", async () => {
    f.turn = { status: 429, body: { error: "chat_daily_cap", used: 15, limit: 15 } };
    mount();
    await waitFor(() => expect(box().disabled).toBe(false));
    fireEvent.change(box(), { target: { value: "One more" } });
    await act(async () => fireEvent.keyDown(box(), { key: "Enter" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("link", { name: en.seePlans }).getAttribute("href")).toBe("/chronos/credits#plans");
    expect(alert.textContent).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("a reached daily cap has a press: the plans", async () => {
    f.plan = { used: 15, limit: 15, trial_left: null, max_input_chars: 2000 };
    mount();
    await screen.findByText(/used up \(15 of 15\)/);
    expect(screen.getByRole("link", { name: en.seePlans }).getAttribute("href")).toBe("/chronos/credits#plans");
  });

  it("\"check back later\" and \"try again later\" each have a Check again that reads the state afresh", async () => {
    for (const setup of [() => { f.brainStatus = 503; f.brainBody = { error: "not_enabled" }; }, () => { f.model = "not_configured"; }]) {
      cleanup();
      f.brainStatus = 200;
      f.brainBody = null;
      f.model = "available";
      setup();
      f.urls = [];
      mount();
      const again = await screen.findByRole("button", { name: en.checkAgain });
      const reads = () => f.urls.filter((u) => u.startsWith("GET /api/brain?")).length;
      expect(reads()).toBe(1);
      f.brainStatus = 200;
      f.brainBody = null;
      f.model = "available";
      await act(async () => fireEvent.click(again));
      await waitFor(() => expect(box().disabled).toBe(false));
      expect(reads()).toBe(2);
    }
  });

  it("while loading, the title already starts where it will be (the history button's place is kept)", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const base = fetch as unknown as (url: string, init?: RequestInit) => Promise<unknown>;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/brain?")) await gate;
      return base(url, init);
    }));
    mount();
    const head = panel().querySelector(".chat-head")!;
    expect(head.firstElementChild?.classList.contains("chat-act")).toBe(true);
    expect(head.firstElementChild?.getAttribute("aria-hidden")).not.toBeNull();
    await act(async () => release());
    const open = await screen.findByRole("button", { name: en.history.open });
    expect(panel().querySelector(".chat-head")?.firstElementChild).toBe(open);
  });

  it("focusing the box brings the box and Send into view (nearest), above the phone's canvas dock", async () => {
    mount();
    await waitFor(() => expect(box().disabled).toBe(false));
    const seen: [Element, ScrollIntoViewOptions | boolean | undefined][] = [];
    Element.prototype.scrollIntoView = function (this: Element, arg?: ScrollIntoViewOptions | boolean) {
      seen.push([this, arg]);
    };
    await act(async () => box().focus());
    const composer = box().closest(".chat-composer");
    expect(seen.some(([el, arg]) => el === composer && typeof arg === "object" && arg.block === "nearest")).toBe(true);
  });

  it("no plan names typed into the copy, and no \"coming soon\" promise, in any language", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const d = dictionaries[loc].aiChat;
      expect(d.planLocked).not.toMatch(/Plus|Pro\b|Business/);
      expect(JSON.stringify(d)).not.toMatch(/coming soon|скоро|tez orada/i);
      for (const k of ["checkAgain", "seePlans", "confirmAge"] as const) expect(d[k].length).toBeGreaterThan(0);
      expect(d.errors.adult_attestation_required.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify([dictionaries.uz.aiChat.planLocked, dictionaries.uz.aiChat.errors.adult_only_service, dictionaries.uz.aiChat.seePlans])).not.toMatch(/'/);
  });
});
