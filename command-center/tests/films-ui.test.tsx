// @vitest-environment jsdom
/**
 * Studio → Projects on screen (components/films). What would break without these: an empty list that says nothing or offers nothing;
 * a viewer offered "New project" or editable fields; a double press that makes two drafts, or a retry that makes a second one; a stale
 * save that overwrites silently instead of saying "someone else changed this project"; a rate-limited save that loses the work or
 * keeps hammering; autosave that fires on every keystroke (240 saves an hour is the database's ceiling); a price, a number or an
 * enabled Start on the dock while pricing is not live; the AI writer offered as if it existed; and the keyboard path (arrows, reorder,
 * add, undo, the palette) not working.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { filmStudioEn as t } from "../lib/i18n/film-studio/en";
import { coerceFilmView } from "../lib/films";
import { FILM, PIC, S1, S2, filmJson, sceneJson } from "./films-fixtures";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: () => {} }), usePathname: () => "/alpha/create/projects" }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (s: string) => `/alpha${s}` }));

const { FilmList } = await import("../components/films/FilmList");
const { FilmCanvas } = await import("../components/films/FilmCanvas");
const { AUTOSAVE_IDLE_MS, AUTOSAVE_MIN_GAP_MS } = await import("../components/films/useFilmProject");

let calls: { method: string; url: string; body: Record<string, unknown> | undefined }[] = [];
let answer: (url: string, method: string, body: Record<string, unknown> | undefined) => { status: number; body: unknown };

beforeEach(() => {
  calls = [];
  push.mockReset();
  window.localStorage.clear();
  answer = () => ({ status: 200, body: { film: filmJson() } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ method, url, body });
      const a = answer(url, method, body);
      return new Response(JSON.stringify(a.body), { status: a.status });
    }),
  );
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const view = (over: Record<string, unknown> = {}, scenes = [sceneJson(S1, 0), sceneJson(S2, 1)]) => coerceFilmView(filmJson(over, scenes))!;
const canvas = (v = view(), canEdit = true) =>
  render(<FilmCanvas initial={v} canEdit={canEdit} pictures={[{ id: PIC, name: "pic.png", thumbUrl: null }]} characters={[]} listHref="/alpha/create/projects" />);

describe("last-clip deletion focus", () => {
  it.each(["Delete", "Backspace", "inspector"])("keeps Commands reachable after removing the last clip through %s", async (removal) => {
    vi.useFakeTimers();
    canvas(view({}, [sceneJson(S1, 0)]));
    const timeline = () => within(screen.getByTestId("fs-timeline"));
    const narration = screen.getByTestId("fs-timeline").querySelector(".fs-narr-block")?.textContent;
    const total = screen.getByTestId("fs-total").textContent;
    fireEvent.click(timeline().getByRole("button"));
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    if (removal === "inspector") {
      const button = screen.getAllByRole("button", { name: t.scene.remove })[0];
      button.focus();
      fireEvent.click(button);
    } else {
      const cell = within(screen.getByTestId("fs-board")).getByRole("option");
      cell.focus();
      fireEvent.keyDown(cell, { key: removal });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    const commands = screen.getByTestId("fs-open-palette");
    expect(timeline().queryAllByRole("button")).toHaveLength(0);
    expect(document.activeElement).toBe(commands);
    fireEvent.click(commands);
    const palette = screen.getByTestId("fs-palette");
    expect(within(palette).getByText(t.canvas.addScene).closest("[role=option]")?.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.keyDown(palette, { key: "Escape" });
    expect(document.activeElement).toBe(commands);
    fireEvent.keyDown(commands, { key: "z", ctrlKey: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(timeline().getAllByRole("button")).toHaveLength(1);
    expect(screen.getByTestId("fs-timeline").querySelector(".fs-narr-block")?.textContent).toBe(narration);
    expect(screen.getByTestId("fs-total").textContent).toBe(total);
    expect(document.activeElement).toBe(commands);
    expect(calls).toEqual([]);
  });

  it("keeps a surviving selected neighbor focused", async () => {
    vi.useFakeTimers();
    canvas();
    const cells = within(screen.getByTestId("fs-board")).getAllByRole("option");
    fireEvent.keyDown(cells[0], { key: "ArrowRight" });
    cells[1].focus();
    fireEvent.keyDown(cells[1], { key: "Delete" });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(document.activeElement).toBe(cells[0]);
    expect(cells[0].getAttribute("aria-selected")).toBe("true");
    expect(calls).toEqual([]);
  });

  it("preserves focus moved to a project field after removal", async () => {
    vi.useFakeTimers();
    canvas(view({}, [sceneJson(S1, 0)]));
    const cell = within(screen.getByTestId("fs-board")).getByRole("option");
    cell.focus();
    fireEvent.keyDown(cell, { key: "Delete" });
    const field = screen.getAllByRole("textbox")[0];
    field.focus();
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(document.activeElement).toBe(field);
    expect(calls).toEqual([]);
  });
});

describe("the list", () => {
  it("empty: says so and offers a new project; a viewer gets neither the button nor editable anything", () => {
    render(<FilmList initial={{ state: "ok", films: [] }} canEdit channel={null} studioName="Studio" />);
    expect(screen.getByTestId("fs-empty").textContent).toContain(t.list.empty);
    expect(screen.getAllByRole("button", { name: new RegExp(t.list.newProject) }).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Your Studio projects" })).toBeTruthy();
    cleanup();
    render(<FilmList initial={{ state: "ok", films: [] }} canEdit={false} channel={null} studioName="Studio" />);
    expect(screen.queryByRole("button", { name: new RegExp(t.list.newProject) })).toBeNull();
    expect(screen.getByText(t.list.readOnly)).toBeTruthy();
  });

  it("a failed read says so with a retry, and not set up says so (never an empty list)", async () => {
    render(<FilmList initial={{ state: "failed" }} canEdit channel={null} studioName="Studio" />);
    expect(screen.getByText(t.list.loadFailed)).toBeTruthy();
    answer = () => ({ status: 200, body: { films: [] } });
    fireEvent.click(screen.getByRole("button", { name: t.retry }));
    await waitFor(() => expect(screen.getByTestId("fs-empty")).toBeTruthy());
    cleanup();
    render(<FilmList initial={{ state: "not_available" }} canEdit channel={null} studioName="Studio" />);
    expect(screen.getByText(t.notAvailable)).toBeTruthy();
  });

  it("creates one draft per press, with one key reused on a retry and a new key once the form changes", async () => {
    let n = 0;
    answer = (url, method) => {
      if (method !== "POST") return { status: 200, body: { films: [] } };
      n += 1;
      return n === 1 ? { status: 503, body: { error: "rate_limit_unavailable" } } : { status: 201, body: { film: filmJson() } };
    };
    render(<FilmList initial={{ state: "ok", films: [] }} canEdit channel={{ id: "night-owl", name: "Night Owl" }} studioName="Studio" />);
    fireEvent.click(screen.getByTestId("fs-new"));
    fireEvent.change(screen.getByLabelText(t.create.topicLabel), { target: { value: "Football in 2050" } });
    fireEvent.change(screen.getByLabelText(t.create.titleLabel), { target: { value: "The stadium" } });
    fireEvent.click(screen.getByTestId("fs-create"));
    await waitFor(() => expect(screen.getByTestId("fs-error-rate_limit_unavailable")).toBeTruthy());
    fireEvent.click(screen.getByTestId("fs-create"));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/alpha/create/projects/${FILM}`));
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0].body?.idem).toBe(posts[1].body?.idem);
    expect(posts[0].body).toMatchObject({ source_kind: "topic", title: "The stadium", channel_id: "night-owl", target_seconds: 300, language: "en", aspect: "16:9" });
  });

  it("says what is missing instead of sending an empty form", () => {
    render(<FilmList initial={{ state: "ok", films: [] }} canEdit channel={null} studioName="Studio" />);
    fireEvent.click(screen.getByTestId("fs-new"));
    fireEvent.click(screen.getByTestId("fs-create"));
    expect(screen.getAllByText(t.create.required).length).toBe(2);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("the canvas", () => {
  it("the dock: Start is off with its reason, and there is no number or price on it (pricing is not live)", () => {
    canvas();
    const start = screen.getAllByTestId("fs-start")[0] as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    const why = document.getElementById(start.getAttribute("aria-describedby")!);
    expect(why?.textContent).toBe(t.dock.notLive);
    const dock = screen.getByTestId("fs-dock");
    const quoteSide = dock.querySelector(".fs-dock-quote")!;
    expect(quoteSide.textContent).not.toMatch(/\d/);
    expect(dock.textContent).not.toMatch(/cr\b|credit|\$/i);
  });

  it("the AI writer is off with its reason; the storyboard is written by hand", () => {
    canvas();
    const ai = screen.getByTestId("fs-ai") as HTMLButtonElement;
    expect(ai.disabled).toBe(true);
    expect(document.getElementById(ai.getAttribute("aria-describedby")!)?.textContent).toBe(t.canvas.aiWriteReason);
  });

  it("an empty storyboard says so and adds a first scene", () => {
    canvas(view({}, []));
    expect(screen.getByTestId("fs-board-empty").textContent).toContain(t.canvas.empty);
    fireEvent.click(within(screen.getByTestId("fs-board-empty")).getByRole("button", { name: t.canvas.addScene }));
    expect(within(screen.getByTestId("fs-board")).getAllByRole("option")).toHaveLength(1);
  });

  it("a viewer reads it: a notice, no add, no archive, every field disabled, and no Save", () => {
    canvas(view(), false);
    expect(screen.getByTestId("fs-viewer").textContent).toContain(t.canvas.viewer);
    expect(screen.queryByTestId("fs-add")).toBeNull();
    expect(screen.queryByTestId("fs-archive")).toBeNull();
    expect(screen.queryByTestId("fs-save")).toBeNull();
    for (const el of document.querySelectorAll<HTMLInputElement>(".fs-inspector-wide input, .fs-inspector-wide textarea, .fs-inspector-wide select")) expect(el.disabled).toBe(true);
  });

  it("an archived project is read-only and says so", () => {
    canvas(view({ status: "archived", archived_at: "2026-11-14T10:00:00Z" }));
    expect(screen.getByTestId("fs-archived").textContent).toContain(t.canvas.archived);
    expect(screen.queryByTestId("fs-add")).toBeNull();
  });

  it("a stale save says someone else changed it, overwrites nothing, stops autosave, and loads the latest on request", async () => {
    answer = (url, method) =>
      method === "PATCH" ? { status: 409, body: { error: "film_changed" } } : { status: 200, body: { film: filmJson({ title: "Their title", version: 5 }) } };
    canvas();
    fireEvent.change(screen.getByLabelText(t.scene.title), { target: { value: "My title" } });
    fireEvent.click(screen.getAllByTestId("fs-save")[0]);
    await waitFor(() => expect(screen.getByTestId("fs-conflict")).toBeTruthy());
    expect(screen.getAllByTestId("fs-save-state")[0].textContent).toBe(t.canvas.saveState.elsewhere);
    expect((screen.getAllByTestId("fs-save")[0] as HTMLButtonElement).disabled).toBe(true);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: t.canvas.reload }));
    await waitFor(() => expect(screen.queryByTestId("fs-conflict")).toBeNull());
    expect(calls.at(-1)).toMatchObject({ method: "GET", url: `/api/films/${FILM}` });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Their title");
  });

  it("a rate-limited save keeps the work and says to wait", async () => {
    answer = (url, method) => (method === "PATCH" ? { status: 429, body: { error: "rate_limited" } } : { status: 200, body: { film: filmJson() } });
    canvas();
    fireEvent.change(screen.getByLabelText(t.scene.title), { target: { value: "Kept" } });
    fireEvent.click(screen.getAllByTestId("fs-save")[0]);
    await waitFor(() => expect(screen.getByTestId("fs-error-rate_limited").textContent).toContain(t.errors.rate_limited));
    expect((screen.getByLabelText(t.scene.title) as HTMLInputElement).value).toBe("Kept");
  });

  it("an ended session says so with a sign-in link and keeps the work", async () => {
    answer = (url, method) => (method === "PATCH" ? { status: 401, body: { error: "session_expired" } } : { status: 200, body: { film: filmJson() } });
    canvas();
    fireEvent.change(screen.getByLabelText(t.scene.title), { target: { value: "Kept" } });
    fireEvent.click(screen.getAllByTestId("fs-save")[0]);
    await waitFor(() => expect(screen.getByTestId("fs-error-session_expired")).toBeTruthy());
    expect(screen.getByRole("link", { name: t.signIn }).getAttribute("target")).toBe("_blank");
    expect((screen.getByLabelText(t.scene.title) as HTMLInputElement).value).toBe("Kept");
  });

  it("autosaves once after the person stops, and never sooner than the gap after the last save", async () => {
    vi.useFakeTimers();
    answer = (url, method, body) => {
      if (method !== "PATCH") return { status: 200, body: { film: filmJson() } };
      const patch = body?.patch as { scenes?: Record<string, unknown>[] };
      const scenes = (patch.scenes ?? []).map((s, i) => sceneJson(String(s.id ?? S1), i, s));
      return { status: 200, body: { film: filmJson({ version: 4 }, scenes) } };
    };
    canvas();
    const title = screen.getByLabelText(t.scene.title);
    for (const v of ["A", "AB", "ABC"]) fireEvent.change(title, { target: { value: v } });
    expect(screen.getAllByTestId("fs-save-state")[0].textContent).toBe(t.canvas.saveState.pending);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS - 100);
    });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect((patches[0].body?.patch as { scenes: { title: string }[] }).scenes[0].title).toBe("ABC");
    expect(patches[0].body?.version).toBe(3);
    // A second edit right away waits for the gap, not just the idle time.
    fireEvent.change(title, { target: { value: "ABCD" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS + 500);
    });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MIN_GAP_MS);
    });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2);
    expect(calls.filter((c) => c.method === "PATCH")[1].body?.version).toBe(4);
  });

  it("does not autosave while a field needs fixing, and says so", async () => {
    vi.useFakeTimers();
    canvas();
    fireEvent.change(screen.getByLabelText(t.scene.title), { target: { value: "x".repeat(200) } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MIN_GAP_MS * 2);
    });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    expect(screen.getAllByTestId("fs-save-state")[0].textContent).toBe(t.canvas.saveState.fix);
  });

  it("the keyboard: arrows move, Alt+arrow reorders, N adds, Delete deletes, undo puts it back", () => {
    canvas();
    const board = screen.getByTestId("fs-board");
    const titles = () => within(screen.getByTestId("fs-board")).getAllByRole("option").map((o) => o.getAttribute("aria-label")?.split(".")[0]);
    expect(titles()).toEqual(["Scene 1: Scene 1", "Scene 2: Scene 2"]);
    fireEvent.keyDown(board, { key: "ArrowRight" });
    expect(within(screen.getByTestId("fs-board")).getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(board, { key: "ArrowUp", altKey: true });
    expect(titles()).toEqual(["Scene 1: Scene 2", "Scene 2: Scene 1"]);
    expect(document.querySelector(".fs-sr")?.textContent).toBe("Scene 2 moved to place 1.");
    fireEvent.keyDown(board, { key: "ArrowDown", altKey: true });
    expect(titles()).toEqual(["Scene 1: Scene 1", "Scene 2: Scene 2"]);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(titles()).toEqual(["Scene 1: Scene 2", "Scene 2: Scene 1"]);
    fireEvent.keyDown(board, { key: "n" });
    expect(within(screen.getByTestId("fs-board")).getAllByRole("option")).toHaveLength(3);
    fireEvent.keyDown(board, { key: "Delete" });
    expect(within(screen.getByTestId("fs-board")).getAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(within(screen.getByTestId("fs-board")).getAllByRole("option")).toHaveLength(3);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(titles()).toEqual(["Scene 1: Scene 1", "Scene 2: Scene 2"]);
  });

  it("Ctrl+K opens the command palette, which lists disabled actions with their reason, and ? opens the shortcuts", () => {
    canvas(view(), false);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const pal = screen.getByTestId("fs-palette");
    const add = within(pal).getByText(t.canvas.addScene).closest("[role=option]")!;
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(add.textContent).toContain(t.palette.readOnly);
    fireEvent.keyDown(pal, { key: "Escape" });
    expect(screen.queryByTestId("fs-palette")).toBeNull();
    fireEvent.keyDown(document.body, { key: "?" });
    expect(screen.getByTestId("fs-shortcuts")).toBeTruthy();
  });

  it("the timeline is as long as the planned scenes and reads them against the target and the ceiling", () => {
    canvas();
    expect(screen.getByTestId("fs-total").textContent).toBe("0:16 of 20:00 at most · target 5:00");
    fireEvent.click(within(screen.getByTestId("fs-timeline")).getByRole("button", { name: "Scene 2, 0:08" }));
    expect(within(screen.getByTestId("fs-board")).getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
  });

  it("a scene that cannot continue from a previous one is told why, not hidden", () => {
    canvas();
    fireEvent.click(within(screen.getByTestId("fs-board")).getAllByRole("option")[0]);
    const prev = screen.getByLabelText(new RegExp(t.scene.ff.previous)) as HTMLInputElement;
    expect(prev.disabled).toBe(true);
    expect(screen.getByText(t.scene.previousNotFirst)).toBeTruthy();
  });
});
