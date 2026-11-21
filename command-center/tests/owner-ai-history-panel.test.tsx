// @vitest-environment jsdom
/**
 * The owner's Nightshift AI history panel (shared ChatHistory in components/chat) and its owner-only route
 * /api/brain/owner/history. What would break:
 *  - anyone but the platform owner reaching a stored conversation (the route must 404 before any database call);
 *  - the panel calling anything but the 0209 functions (rename -> owner_ai_session_rename, delete -> owner_ai_session_delete);
 *  - a rename or delete that failed left on screen as if it had worked (optimistic UI must roll back and say why);
 *  - a chat deleted on another device retried forever instead of dropped with a notice;
 *  - loading, empty and error drawn as the same blank column, or an error with no way to try again;
 *  - the phone drawer that cannot be closed by Esc / an outside tap / a pick, or lets Tab wander behind it;
 *  - blocked localStorage (private mode) crashing the page;
 *  - an opened chat continued as a NEW stored chat (the session id not sent with the next question).
 * Every fetch and every database call is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";

vi.mock("server-only", () => ({}));

const s = vi.hoisted(() => ({
  user: { id: "owner-1" } as { id: string } | null,
  access: "owner",
  cross: null as Response | null,
  rpc: {} as Record<string, { data?: unknown; error?: unknown }>,
  rpcCalls: [] as { name: string; args: unknown }[],
}));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => s.user,
  createClient: async () => ({
    rpc: async (name: string, args: unknown) => {
      s.rpcCalls.push({ name, args });
      return s.rpc[name] ?? { data: null, error: null };
    },
  }),
}));
vi.mock("@/lib/server/same-origin", () => ({ rejectCrossOrigin: () => s.cross }));
vi.mock("@/lib/server/owner-analytics", () => ({ ownerAccess: async () => s.access }));

const { OwnerAssistant, turnsFromMessages } = await import("../components/owner-console/OwnerAssistant");
const { relativeTime } = await import("../components/chat/ChatHistory");
const route = await import("../app/api/brain/owner/history/route");

const a = en.ownerConsole.assistant;
const h = a.history;
const S1 = "11111111-2222-4333-8444-555555555551";
const S2 = "11111111-2222-4333-8444-555555555552";
const NEW = "11111111-2222-4333-8444-555555555553";

describe("history strings", () => {
  it("exist in en, ru and uz with the same keys", () => {
    const keys = Object.keys(h).sort();
    expect(Object.keys(ru.ownerConsole.assistant.history).sort()).toEqual(keys);
    expect(Object.keys(uz.ownerConsole.assistant.history).sort()).toEqual(keys);
    expect(h.empty).toBe("No conversations yet");
  });
});

describe("/api/brain/owner/history", () => {
  beforeEach(() => {
    s.user = { id: "owner-1" };
    s.access = "owner";
    s.cross = null;
    s.rpc = {};
    s.rpcCalls = [];
  });
  const req = (url: string, init?: RequestInit) => new Request(`http://localhost${url}`, init);

  it("is a 404 for a signed-in non-owner and for nobody, before any database call", async () => {
    s.access = "member";
    expect((await route.GET(req("/api/brain/owner/history"))).status).toBe(404);
    expect((await route.DELETE(req(`/api/brain/owner/history?session=${S1}`, { method: "DELETE" }))).status).toBe(404);
    s.user = null;
    s.access = "owner";
    expect((await route.GET(req(`/api/brain/owner/history?session=${S1}`))).status).toBe(404);
    expect(s.rpcCalls).toEqual([]);
  });

  it("lists through owner_ai_session_list with the page size and the (updated_at, id) cursor, and hands back the next cursor only on a full page", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: `${S1.slice(0, -2)}${String(i).padStart(2, "0")}`, title: `t${i}`, created_at: "x", updated_at: `2026-11-21T0${i % 10}:00:00Z` }));
    s.rpc.owner_ai_session_list = { data: rows, error: null };
    const res = await route.GET(req(`/api/brain/owner/history?before=${encodeURIComponent(`2026-11-21T10:00:00Z|${S2}`)}`));
    const body = await res.json();
    // Both halves reach the database: two chats saved in the same microsecond are neither skipped nor shown twice.
    expect(s.rpcCalls).toEqual([{ name: "owner_ai_session_list", args: { p_limit: 30, p_before: "2026-11-21T10:00:00Z", p_before_id: S2 } }]);
    expect(body.sessions).toHaveLength(30);
    expect(body.next_before).toBe(`${rows[29].updated_at}|${rows[29].id}`);
    s.rpc.owner_ai_session_list = { data: rows.slice(0, 3), error: null };
    expect((await (await route.GET(req("/api/brain/owner/history"))).json()).next_before).toBeNull();
  });

  it("refuses a cursor whose id is not a uuid before the database", async () => {
    expect((await route.GET(req(`/api/brain/owner/history?before=${encodeURIComponent("2026-11-21T10:00:00Z|x' or 1=1")}`))).status).toBe(400);
    expect(s.rpcCalls).toEqual([]);
  });

  it("counts a rename's length in characters as the database does: 60 emoji are a valid title", async () => {
    const title = "😀".repeat(60);
    expect((await route.PATCH(req("/api/brain/owner/history", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: S1, title }) }))).status).toBe(200);
    expect((await route.PATCH(req("/api/brain/owner/history", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: S1, title: title + "😀" }) }))).status).toBe(400);
  });

  it("names a session deleted elsewhere as gone, a missing migration as not_enabled 0209, and the second factor as such", async () => {
    s.rpc.owner_ai_session_messages = { data: null, error: { code: "P0002" } };
    let res = await route.GET(req(`/api/brain/owner/history?session=${S1}`));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "gone" });
    s.rpc.owner_ai_session_messages = { data: null, error: { code: "PGRST202" } };
    expect(await (await route.GET(req(`/api/brain/owner/history?session=${S1}`))).json()).toEqual({ error: "not_enabled", needs: "0209" });
    s.rpc.owner_ai_session_messages = { data: null, error: { code: "NS401" } };
    res = await route.GET(req(`/api/brain/owner/history?session=${S1}`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "second_factor" });
  });

  it("renames through owner_ai_session_rename and deletes through owner_ai_session_delete, refusing a bad id before the database", async () => {
    const patch = await route.PATCH(req("/api/brain/owner/history", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: S1, title: "  Runway   check " }) }));
    expect(patch.status).toBe(200);
    const del = await route.DELETE(req(`/api/brain/owner/history?session=${S2}`, { method: "DELETE" }));
    expect(del.status).toBe(200);
    expect((await route.DELETE(req("/api/brain/owner/history?session=not-a-uuid", { method: "DELETE" }))).status).toBe(400);
    expect(s.rpcCalls).toEqual([
      { name: "owner_ai_session_rename", args: { p_session: S1, p_title: "Runway check" } },
      { name: "owner_ai_session_delete", args: { p_session: S2 } },
    ]);
  });

  it("refuses a cross-origin rename or delete", async () => {
    s.cross = new Response(null, { status: 403 });
    expect((await route.PATCH(req("/api/brain/owner/history", { method: "PATCH", body: "{}" }))).status).toBe(403);
    expect((await route.DELETE(req(`/api/brain/owner/history?session=${S1}`, { method: "DELETE" }))).status).toBe(403);
    expect(s.rpcCalls).toEqual([]);
  });
});

describe("turnsFromMessages", () => {
  it("pairs questions with answers and says so when an answer was not saved", () => {
    const t = turnsFromMessages(a, [
      { role: "owner", text: "q1", as_of: null },
      { role: "ai", text: "a1", as_of: "2026-11-21T03:00:00Z" },
      { role: "owner", text: "q2", as_of: null },
      { role: "owner", text: "q3", as_of: null },
      { role: "ai", text: "a3", as_of: null },
    ]);
    expect(t.map((x) => [x.q, x.a])).toEqual([
      ["q1", "a1"],
      ["q2", h.noAnswer],
      ["q3", "a3"],
    ]);
  });
});

describe("relativeTime", () => {
  it("says the time relative to now, in the page's language", () => {
    const now = Date.parse("2026-11-21T12:00:00Z");
    expect(relativeTime("2026-11-21T11:55:00Z", "en", now)).toBe("5 minutes ago");
    expect(relativeTime("2026-11-20T12:00:00Z", "en", now)).toBe("yesterday");
    expect(relativeTime("not a date", "en", now)).toBe("");
  });
});

describe("the history panel", () => {
  const fetchMock = vi.fn();
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
  const LIST = { sessions: [
    { id: S1, title: "Which API must I pay?", updated_at: new Date(Date.now() - 120_000).toISOString() },
    { id: S2, title: "Signups this week", updated_at: new Date(Date.now() - 3 * 86_400_000).toISOString() },
  ], next_before: null };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    // Node's own (flagged) localStorage shadows jsdom's here: an in-memory one keeps the test about the panel, not the runtime.
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k), clear: () => mem.clear() });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const mount = () => render(<OwnerAssistant a={a} greeting="Hello" verifyHref="/verify" signInHref="/login" history locale="en" />);
  // By id: the same aside is a landmark on desktop and a modal dialog while the phone drawer is open.
  const panel = () => within(document.getElementById("chat-history")!);
  // Anchored on the title: the row's "Options: {title}" button must not match too.
  const row = (title: string) => panel().findByRole("button", { name: new RegExp(`^${title.replace(/[?]/g, "\\?")}`) });
  const rows = () => Array.from(document.querySelectorAll("#chat-history .chat-history-title")).map((e) => e.textContent);
  const calls = () => fetchMock.mock.calls.map((c) => [c[0], (c[1] as RequestInit | undefined)?.method ?? "GET"]);

  it("shows a loading skeleton, then the sessions newest first with a relative time", async () => {
    let resolve!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    mount();
    expect(panel().getByLabelText(h.loading).getAttribute("aria-busy")).toBe("true");
    await act(async () => resolve(json(200, LIST)));
    expect((await row("Which API must I pay?")).textContent).toBe("Which API must I pay?2 minutes ago");
    expect((await row("Signups this week")).textContent).toBe("Signups this week3 days ago");
    expect(rows()).toEqual(["Which API must I pay?", "Signups this week"]);
    expect(calls()).toEqual([["/api/brain/owner/history", "GET"]]);
  });

  it("shows the empty line when there are no conversations", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { sessions: [], next_before: null }));
    mount();
    expect(await panel().findByText(h.empty)).toBeTruthy();
  });

  it("shows the error with its remedy and a retry that loads again", async () => {
    fetchMock.mockResolvedValueOnce(json(503, { error: "not_enabled", needs: "0209" })).mockResolvedValueOnce(json(200, LIST));
    mount();
    const alert = await panel().findByRole("alert");
    expect(alert.textContent).toContain("0209");
    fireEvent.click(within(alert).getByRole("button", { name: h.retry }));
    expect(await panel().findByText("Signups this week")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("opens a session through the messages call and sends its id with the next question", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, LIST))
      .mockResolvedValueOnce(json(200, { messages: [{ role: "owner", text: "Which API must I pay?", as_of: null }, { role: "ai", text: "Pay Lab Vendor.", as_of: null }] }))
      .mockResolvedValueOnce(json(200, { answer: "Nothing else.", draft: null, removed_links: 0, as_of: null, model: "m", session_id: S1, history: "saved" }));
    mount();
    fireEvent.click(await row("Which API must I pay?"));
    expect(await screen.findByText("Pay Lab Vendor.")).toBeTruthy();
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/brain/owner/history?session=${S1}`);
    fireEvent.change(screen.getByLabelText(a.label), { target: { value: "Anything else?" } });
    await act(async () => fireEvent.submit(screen.getByLabelText(a.label).closest("form")!));
    expect(fetchMock.mock.calls[2][0]).toBe("/api/brain/owner/turn");
    const body = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string);
    expect(body.session_id).toBe(S1);
    expect(body.history).toEqual([{ q: "Which API must I pay?", a: "Pay Lab Vendor." }]);
  });

  it("drops a session deleted on another device and says so", async () => {
    fetchMock.mockResolvedValueOnce(json(200, LIST)).mockResolvedValueOnce(json(404, { error: "gone" }));
    mount();
    fireEvent.click(await row("Signups this week"));
    expect(await panel().findByText(h.gone)).toBeTruthy();
    expect(rows()).toEqual(["Which API must I pay?"]);
  });

  it("renames inline through PATCH, and rolls back with the reason when it fails", async () => {
    fetchMock.mockResolvedValueOnce(json(200, LIST)).mockResolvedValueOnce(json(200, { ok: true, title: "Runway" })).mockResolvedValueOnce(json(503, { error: "unavailable" }));
    mount();
    const rename = async (from: string, to: string) => {
      fireEvent.click(await panel().findByRole("button", { name: h.options.replace("{title}", from) }));
      fireEvent.click(panel().getByRole("menuitem", { name: h.rename }));
      fireEvent.change(panel().getByLabelText(h.renameLabel), { target: { value: to } });
      await act(async () => fireEvent.click(panel().getByRole("button", { name: h.save })));
    };
    await rename("Which API must I pay?", "Runway");
    expect(panel().getByText("Runway")).toBeTruthy();
    expect(fetchMock.mock.calls[1][0]).toBe("/api/brain/owner/history");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ session: S1, title: "Runway" }) });

    await rename("Signups this week", "Growth");
    expect(panel().queryByText("Growth")).toBeNull();
    expect(panel().getByText("Signups this week")).toBeTruthy();
    expect(panel().getByRole("alert").textContent).toBe(h.failed);
  });

  it("deletes only after the confirm dialog, through DELETE, and puts the row back when it fails", async () => {
    fetchMock.mockResolvedValueOnce(json(200, LIST)).mockResolvedValueOnce(json(503, { error: "unavailable" })).mockResolvedValueOnce(json(200, { ok: true }));
    mount();
    const askDelete = async () => {
      fireEvent.click(await panel().findByRole("button", { name: h.options.replace("{title}", "Signups this week") }));
      fireEvent.click(panel().getByRole("menuitem", { name: h.delete }));
      return panel().getByRole("alertdialog");
    };
    let dialog = await askDelete();
    fireEvent.click(within(dialog).getByRole("button", { name: h.cancel }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    dialog = await askDelete();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: h.delete })));
    expect(fetchMock.mock.calls[1]).toEqual([`/api/brain/owner/history?session=${S2}`, { method: "DELETE" }]);
    expect(rows()).toEqual(["Which API must I pay?", "Signups this week"]);
    expect(panel().getByRole("alert").textContent).toBe(h.failed);

    dialog = await askDelete();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: h.delete })));
    expect(panel().queryByText("Signups this week")).toBeNull();
  });

  it("shows a new stored chat in the list after its first answer", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { sessions: [], next_before: null }))
      .mockResolvedValueOnce(json(200, { answer: "Pay Lab Vendor.", draft: null, removed_links: 0, as_of: null, model: "m", session_id: NEW, history: "saved" }))
      .mockResolvedValueOnce(json(200, { sessions: [{ id: NEW, title: "Which API?", updated_at: new Date().toISOString() }], next_before: null }));
    mount();
    await panel().findByText(h.empty);
    fireEvent.change(screen.getByLabelText(a.label), { target: { value: "Which API?" } });
    await act(async () => fireEvent.submit(screen.getByLabelText(a.label).closest("form")!));
    expect((await row("Which API?")).getAttribute("aria-current")).toBe("true");
    expect(fetchMock.mock.calls[2][0]).toBe("/api/brain/owner/history");
    // The answer says it was saved, because the route said so.
    expect(screen.getByText(a.saveState.saved).getAttribute("data-history")).toBe("saved");
  });

  it.each([
    ["not_saved", a.saveState.not_saved],
    ["needs_migration", a.saveState.needs_migration],
    // A route that does not say is not read as saved (rule 5).
    [undefined, a.saveState.not_saved],
  ])("an answer the route reports as %s says so under the answer, as a warning", async (state, text) => {
    fetchMock
      .mockResolvedValueOnce(json(200, { sessions: [], next_before: null }))
      .mockResolvedValueOnce(json(200, { answer: "Pay Lab Vendor.", draft: null, removed_links: 0, as_of: null, model: "m", session_id: null, history: state }));
    mount();
    await panel().findByText(h.empty);
    fireEvent.change(screen.getByLabelText(a.label), { target: { value: "Which API?" } });
    await act(async () => fireEvent.submit(screen.getByLabelText(a.label).closest("form")!));
    const line = await screen.findByText(text);
    expect(line.getAttribute("data-tone")).toBe("warn");
    expect(screen.queryByText(a.saveState.saved)).toBeNull();
  });

  it("remembers the desktop collapse, and survives storage that throws", async () => {
    fetchMock.mockResolvedValue(json(200, LIST));
    const { container, unmount } = mount();
    fireEvent.click(await panel().findByRole("button", { name: h.collapse }));
    expect(container.querySelector(".chat-frame")?.hasAttribute("data-collapsed")).toBe(true);
    expect(window.localStorage.getItem("ns.owner-ai.history-collapsed")).toBe("1");
    unmount();
    const blocked = () => {
      throw new Error("SecurityError");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
    const again = mount();
    fireEvent.click(await within(again.container).findByRole("button", { name: h.collapse }));
    expect(again.container.querySelector(".chat-frame")?.hasAttribute("data-collapsed")).toBe(true);
  });

  it("phone drawer: the header button opens it; Esc, an outside tap and a pick close it; Tab stays inside", async () => {
    fetchMock.mockResolvedValueOnce(json(200, LIST)).mockResolvedValueOnce(json(200, { messages: [] }));
    const { container } = mount();
    const frame = () => container.querySelector(".chat-frame")!;
    const opener = screen.getByRole("button", { name: h.open, expanded: false });
    await panel().findByText("Signups this week");

    fireEvent.click(opener);
    expect(frame().hasAttribute("data-open")).toBe(true);
    const dialog = screen.getByRole("dialog", { name: h.heading });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled])"));
    focusable[focusable.length - 1].focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(frame().hasAttribute("data-open")).toBe(false);
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    fireEvent.click(screen.getByTestId("history-scrim"));
    expect(frame().hasAttribute("data-open")).toBe(false);

    fireEvent.click(opener);
    const pick = await row("Signups this week");
    await act(async () => fireEvent.click(pick));
    expect(frame().hasAttribute("data-open")).toBe(false);
  });

  it("is not drawn without the history switch (the page sets it only after the owner check)", () => {
    render(<OwnerAssistant a={a} greeting="Hello" verifyHref="/verify" signInHref="/login" />);
    expect(document.getElementById("chat-history")).toBeNull();
    expect(screen.queryByRole("button", { name: h.open })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
