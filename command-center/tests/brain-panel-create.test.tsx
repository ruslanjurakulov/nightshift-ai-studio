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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }), usePathname: () => "/chronos/studio" }));

const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const FILM_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const en = dictionaries.en.aiChat;
const outline = (title: string) => ({ title, idea: `idea ${title}`, target_seconds: 120, characters: [{ id: "c1" }], scenes: [],
  chapters: [{ id: "ch1", title: "a", seconds: 60, beats: [] }, { id: "ch2", title: "b", seconds: 60, beats: [] }] });
const quoteFilm = (total: number) => ({ priced: true, total, quote_id: `fq-2-${"a".repeat(32)}`, startable: true, may_start: true, available: 500 });
const brief = { version: 1, kind: "short", title: "Alpha", idea: "idea Alpha", target_seconds: 120, voice: { mode: "off" }, music: { mode: "off" },
  scenes: [{ id: "s1" }], characters: [], price: { state: "priced", total_credits: 40, spendable: 500, fits: true, shorter: null } };

let sent: Record<string, unknown>[] = [];
let calls: string[] = [];
let total = 40;
const assign = vi.fn();
const REAL_HREF = window.location.href;

beforeEach(() => {
  sent = [];
  calls = [];
  total = 40;
  seen.props = null;
  seen.mounts = 0;
  assign.mockReset();
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  // Only assign() is replaced: the page stays on jsdom's own origin, so history.replaceState (announce) still works.
  Object.defineProperty(window, "location", { configurable: true, value: { href: REAL_HREF, origin: new URL(REAL_HREF).origin, assign } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (url.startsWith("/api/brain/history")) {
      if (/session=/.test(url)) {
        return json(200, { session: { id: S1, step: "proposing" }, card: null, brief: { version: 1, kind: "short" },
          messages: [{ id: 1, role: "assistant", content: "Pick one", payload: { scenarios: [outline("Alpha"), outline("Beta")] } }] });
      }
      return json(200, { sessions: [], next_before: null });
    }
    if (url.startsWith("/api/brain/turn")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      if (body.action === "handoff") return json(200, { ok: true });
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

  it("a start records the handoff once, a replayed one included, and opens the live view", async () => {
    const p = await chosen();
    await act(async () => p.onStarted({ replayed: false }));
    await act(async () => p.onStarted({ replayed: true }));
    await act(async () => seen.props!.onStarted({ replayed: true }));
    const handoffs = sent.filter((b) => b.action === "handoff");
    expect(handoffs).toEqual([{ action: "handoff", session: S1, handoff: { kind: "film", film_id: FILM_ID } }]);
    expect(assign).toHaveBeenCalledWith(`/chronos/studio?view=live&film=${FILM_ID}`);
  });

  it("a replay first (the press already counted) is still recorded, once", async () => {
    const p = await chosen();
    await act(async () => p.onStarted({ replayed: true }));
    await act(async () => p.onStarted({ replayed: false }));
    expect(sent.filter((b) => b.action === "handoff")).toHaveLength(1);
  });

  it("a new price goes through choose for the same outline, a fresh press id, and returns the coerced quote", async () => {
    const p = await chosen();
    total = 55;
    let q: Awaited<ReturnType<NonNullable<FilmCreateButtonProps["requote"]>>> = null;
    await act(async () => { q = await p.requote!(); });
    const chooses = sent.filter((b) => b.action === "choose");
    expect(chooses).toHaveLength(2);
    expect(chooses[1]).toMatchObject({ action: "choose", session: S1, index: 0 });
    expect(chooses[1].request_id).not.toBe(chooses[0].request_id);
    expect(q).toMatchObject({ priced: true, total: 55 });
  });

  it("choose another goes back to the outlines", async () => {
    const p = await chosen();
    expect(screen.queryByRole("button", { name: en.chooseThisNamed.replace("{title}", "Beta") })).toBeNull();
    await act(async () => p.onChooseAnother!());
    expect(screen.getByRole("button", { name: en.chooseThisNamed.replace("{title}", "Beta") })).toBeTruthy();
    expect(screen.queryByTestId("film-create")).toBeNull();
    expect(screen.getByText(en.chooseAgain)).toBeTruthy();
  });

  it("the panel itself never calls a film's start route", async () => {
    const p = await chosen();
    await act(async () => p.onStarted({ replayed: false }));
    expect(calls.some((u) => /\/api\/films\/[^/]+\/start/.test(u))).toBe(false);
    const src = readFileSync(join(__dirname, "../components/brain/NightshiftAiPanel.tsx"), "utf8");
    expect(src).not.toMatch(/\/start[`"']/);
    expect(src).not.toMatch(/api\/films/);
  });
});
