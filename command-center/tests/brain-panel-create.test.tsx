// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { NightshiftAiPanel } from "@/components/brain/NightshiftAiPanel";
import type { FilmCreateButtonProps } from "@/components/studio-timeline/FilmCreateButton";

/**
 * The panel's Create is S2's FilmCreateButton (#905), not a start of its own. What would break without these: a replayed start (the
 * same press counted twice by the start route) recording the conversation's handoff twice; the panel calling /api/films/<id>/start
 * itself, beside the button; a re-price that plans the storyboard again (turns spent on a price); "choose another model" with no way
 * back to the outlines.
 */
const seen = vi.hoisted(() => ({ props: null as FilmCreateButtonProps | null, mounts: 0 }));
vi.mock("@/components/studio-timeline/FilmCreateButton", () => ({
  FilmCreateButton: (p: FilmCreateButtonProps) => {
    seen.props = p;
    seen.mounts += 1;
    return <div data-testid="film-create" data-film={p.filmId} data-total={p.quote?.total ?? ""} />;
  },
}));
const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: nav.replace }), usePathname: () => "/chronos/studio" }));

const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const FILM_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const en = dictionaries.en.aiChat;
const outline = (title: string) => ({ title, idea: `idea ${title}`, target_seconds: 120, characters: [{ id: "c1" }], scenes: [],
  chapters: [{ id: "ch1", title: "a", seconds: 60, beats: [] }, { id: "ch2", title: "b", seconds: 60, beats: [] }] });
const quoteFilm = (total: number) => ({ priced: true, total, quote_id: `fq-2-${"a".repeat(32)}`, startable: true, may_start: true, available: 500 });
const brief = { version: 1, kind: "short", title: "Alpha", idea: "idea Alpha", target_seconds: 120, voice: { mode: "off" }, music: { mode: "off" },
  scenes: [{ id: "s1" }], characters: [], price: { state: "priced", total_credits: 40, spendable: 500, fits: true, shorter: null } };

let sent: Record<string, unknown>[] = [];
let handoffStatus = 200;
let historyGone = false;
let calls: string[] = [];
let total = 40;
const assign = vi.fn();
const REAL_HREF = window.location.href;

beforeEach(() => {
  sent = [];
  calls = [];
  handoffStatus = 200;
  historyGone = false;
  nav.replace.mockReset();
  total = 40;
  seen.props = null;
  seen.mounts = 0;
  assign.mockReset();
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  // Only assign() is replaced: the page stays on jsdom's own origin, so history.replaceState (announce) still works.
  // href follows history (document.URL), as a browser's does.
  window.history.replaceState(null, "", REAL_HREF);
  Object.defineProperty(window, "location", { configurable: true, value: { get href() { return document.URL; }, origin: new URL(REAL_HREF).origin, assign } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (url.startsWith("/api/brain/history")) {
      if (/session=/.test(url) && historyGone) return json(404, { error: "gone" });
      if (/session=/.test(url)) {
        return json(200, { session: { id: S1, step: "proposing" }, card: null, brief: { version: 1, kind: "short" },
          messages: [{ id: 1, role: "assistant", content: "Pick one", payload: { scenarios: [outline("Alpha"), outline("Beta")] } }] });
      }
      return json(200, { sessions: [], next_before: null });
    }
    if (url.startsWith("/api/brain/turn")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      if (body.action === "handoff") return handoffStatus === 200 ? json(200, { ok: true }) : json(handoffStatus, { error: "server_error" });
      return json(200, { brief: { ...brief, price: { ...brief.price, total_credits: total } }, film: { id: FILM_ID, version: 2 },
        models: { clip: null, keyframe: null }, quote: null, film_quote: quoteFilm(total) });
    }
    return json(200, { plan: { used: 0, limit: 30, trial_left: null, max_input_chars: 2000 }, model: "available", canEdit: true, canRun: true,
                       session: { id: S1 }, gate: null });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function chosen() {
  render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" /></I18nProvider>);
  const btn = await screen.findByRole("button", { name: en.chooseThisNamed.replace("{title}", "Alpha") });
  await act(async () => fireEvent.click(btn));
  await waitFor(() => expect(seen.props).not.toBeNull());
  return seen.props!;
}

describe("Nightshift AI panel: Create is S2's FilmCreateButton", () => {
  it("is given the draft, quote_film's answer read by coerceQuote, and the live view as its progress", async () => {
    const p = await chosen();
    expect(p.filmId).toBe(FILM_ID);
    expect(p.quote).toMatchObject({ priced: true, total: 40, quoteId: `fq-2-${"a".repeat(32)}`, startable: true });
    expect(p.progressHref).toBe(`/chronos/studio?view=live&film=${FILM_ID}`);
    expect(screen.getByTestId("film-create").getAttribute("data-film")).toBe(FILM_ID);
  });

  it("a start records the handoff once, a replayed one included, and turns the board in place: no reload", async () => {
    // Measured before (LIVE_CREATION_PLAN item 9): location.assign reloaded the page, 0.35 s with no page and then one without this
    // panel. Now: the handoff event, &film= added to the URL with ?brain= kept, and no navigation at all.
    const u = new URL(window.location.href);
    u.searchParams.set("brain", S1);
    u.searchParams.set("tab", "x");
    window.history.replaceState(null, "", u.toString());
    const replace = vi.spyOn(window.history, "replaceState");
    const heard: unknown[] = [];
    const on = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener("nightshift:brain-handoff", on);
    const p = await chosen();
    await act(async () => p.onStarted({ replayed: false }));
    await act(async () => p.onStarted({ replayed: true }));
    await act(async () => seen.props!.onStarted({ replayed: true }));
    window.removeEventListener("nightshift:brain-handoff", on);
    const handoffs = sent.filter((b) => b.action === "handoff");
    expect(handoffs).toEqual([{ action: "handoff", session: S1, handoff: { kind: "film", film_id: FILM_ID } }]);
    expect(assign).not.toHaveBeenCalled();
    expect(heard[0]).toEqual({ session_id: S1, film_id: FILM_ID });
    const filmCalls = replace.mock.calls.map((c) => new URL(String(c[2]))).filter((x) => x.searchParams.get("film") === FILM_ID);
    expect(filmCalls.length).toBe(1);
    expect(filmCalls[0].searchParams.get("brain")).toBe(S1);
    expect(filmCalls[0].searchParams.get("tab")).toBe("x");
    expect(filmCalls[0].pathname).toBe(new URL(REAL_HREF).pathname);
    expect(new URL(document.URL).searchParams.get("film")).toBe(FILM_ID);
    replace.mockRestore();
  });

  it("a replay first (the press already counted) is still recorded, once", async () => {
    const p = await chosen();
    await act(async () => p.onStarted({ replayed: true }));
    await act(async () => p.onStarted({ replayed: false }));
    expect(sent.filter((b) => b.action === "handoff")).toHaveLength(1);
  });

  it("re-pricing is S2's own (the film's current version, nothing written): the panel passes no requote of its own", async () => {
    // Lens H1: a requote through our choose re-saved the stored storyboard over the person's edits.
    const p = await chosen();
    expect(p.requote).toBeUndefined();
  });

  it("no \"choose another\" that would only draft the same models again (Lens M1)", async () => {
    const p = await chosen();
    expect(p.onChooseAnother).toBeUndefined();
  });

  it("the panel itself never calls a film's start route", async () => {
    const p = await chosen();
    await act(async () => p.onStarted({ replayed: false }));
    expect(calls.some((u) => /\/api\/films\/[^/]+\/start/.test(u))).toBe(false);
    const src = readFileSync(join(__dirname, "../components/brain/NightshiftAiPanel.tsx"), "utf8");
    expect(src).not.toMatch(/\/start[`"']/);
    expect(src).not.toMatch(/api\/films/);
  });

  it("a recorded handoff closes the conversation as a reload would, and keeps Create's own note on screen", async () => {
    const p = await chosen();
    expect(p.inPlace).toBe(true);
    // The "already started" refusal still has its way on; the started state itself offers no key that leaves (FilmCreateButton).
    expect(p.progressHref).toBe(`/chronos/studio?view=live&film=${FILM_ID}`);
    await act(async () => p.onStarted({ replayed: false }));
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true));
    expect(screen.getByTestId("film-create")).toBeTruthy();
    expect(screen.queryByTestId("brain-handoff-failed")).toBeNull();
  });

  it("a handoff the server did not record is said, with a retry that records it (never swallowed)", async () => {
    handoffStatus = 500;
    const p = await chosen();
    await act(async () => p.onStarted({ replayed: false }));
    const line = await screen.findByTestId("brain-handoff-failed");
    expect(line.textContent).toContain(en.handoffFailed);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false);
    handoffStatus = 200;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: en.handoffRetry })));
    await waitFor(() => expect(screen.queryByTestId("brain-handoff-failed")).toBeNull());
    expect(sent.filter((b) => b.action === "handoff")).toHaveLength(2);
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true));
  });

  it("New chat takes the last conversation's film off the URL with its ?brain=", async () => {
    const p = await chosen();
    await act(async () => p.onStarted({ replayed: false }));
    expect(new URL(document.URL).searchParams.get("film")).toBe(FILM_ID);
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: en.shell.newChat })[0]));
    expect(nav.replace).toHaveBeenCalled();
    const to = new URL(String(nav.replace.mock.calls.at(-1)![0]), "http://x");
    expect(to.searchParams.has("brain")).toBe(false);
    expect(to.searchParams.has("film")).toBe(false);
  });

  it("a conversation that is gone is taken off the URL with its film", async () => {
    historyGone = true;
    const u = new URL(REAL_HREF);
    u.searchParams.set("brain", S1);
    u.searchParams.set("film", FILM_ID);
    window.history.replaceState(null, "", u.toString());
    render(<I18nProvider locale="en"><NightshiftAiPanel channelId="c1" channelSlug="chronos" initialSession={S1} /></I18nProvider>);
    await waitFor(() => expect(nav.replace).toHaveBeenCalled());
    const to = new URL(String(nav.replace.mock.calls.at(-1)![0]), "http://x");
    expect(to.searchParams.has("brain")).toBe(false);
    expect(to.searchParams.has("film")).toBe(false);
  });
});
