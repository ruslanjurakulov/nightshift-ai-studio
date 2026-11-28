// @vitest-environment jsdom
/**
 * Create in place (docs/studio/LIVE_CREATION_PLAN.md §3.9, item 9). Measured before: after the person confirmed Create, the panel
 * reloaded the page into `?view=live&film=`: 0.35 s with no page, then a page without the panel, and the first live card 1.2–1.5 s
 * after confirm. What would break without these: the board remounting its cards at Create (the plan the person confirmed vanishing
 * and coming back), a refresh after Create losing the film, a refresh with only ?brain= not finding the film the server recorded,
 * another conversation's film drawn under this one, and the timing marks throwing or firing more than once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { studioLiveEn as c } from "../lib/i18n/studio-live/en";
import { clearBrainActivity, dispatchBrainCanvas, isBrainHandoff } from "../lib/studio/brainActivity";
import { nsMarkOnce, resetNsMarks } from "../lib/studio/nsMark";
import { hasLitStep } from "../lib/studio/boardModel";
import type { LiveGraph, LiveNode } from "../lib/studio/liveGraph";
import { FILM, S1, filmJson, sceneJson } from "./films-fixtures";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/alpha${p}` }));
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({ usePathname: () => "/alpha/studio", useRouter: () => ({ refresh() {} }), useSearchParams: () => search }));

const { PlanColumn } = await import("../components/studio-live/PlanColumn");
const { LiveView } = await import("../components/studio-live/LiveView");
const { StudioSplit } = await import("../components/studio-live/StudioSplit");

const SID = "5e550000-0000-4000-8000-0000000000e1";
const OTHER = "5e550000-0000-4000-8000-0000000000e2";
const brief = (over: Record<string, unknown> = {}) => ({
  version: 1,
  status: "ready",
  kind: "short",
  title: "The kite that came back",
  voice: { mode: "off" },
  music: { mode: "off" },
  characters: [{ id: "c1", name: "Aziza" }],
  scenes: [{ id: "s1", n: 1, title: "Shot 1", visual_prompt: "The kite", duration_s: 3, character_ids: ["c1"] }],
  ...over,
});
const handedOff = brief({ status: "created", handoff: { kind: "film", film_id: FILM } });
const seg = { id: "seg1", status: "running", assembly_status: "planned", assembly_asset_id: null, confirmed_credits: 40, captured_credits: null, assembly_confirmed_credits: 8, assembly_charged_credits: null, created_at: "2026-11-21T00:00:00Z" };
const filmLive = {
  film: filmJson({ status: "running" }, [sceneJson(S1, 0, { current_version: 1, takes: [{ id: "k1", kind: "keyframe", status: "running", version: 1, shot_index: 0, attempt: 1 }] })]),
  segments: [seg],
  takes: [],
};

let urls: string[] = [];
let route: (url: string) => { status: number; body: unknown };
let marks: string[] = [];

beforeEach(() => {
  search = new URLSearchParams();
  urls = [];
  marks = [];
  resetNsMarks();
  window.localStorage.clear();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(performance, "mark").mockImplementation(((name: string) => {
    marks.push(name);
    return undefined;
  }) as unknown as typeof performance.mark);
  route = (url) => (url.startsWith("/api/brain/session/") ? { status: 200, body: { brief: brief() } } : url.endsWith("/live") ? { status: 200, body: filmLive } : { status: 404, body: {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      const a = route(url);
      return new Response(JSON.stringify(a.body), { status: a.status });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearBrainActivity();
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
  });
const card = (id: string) => screen.getByTestId(`plan-card-${id}`);
const stateOf = (id: string) => card(id).closest("article")?.getAttribute("data-state");
const ids = () => [...document.querySelectorAll<HTMLElement>("[data-node-id]")].map((el) => el.dataset.nodeId);
const ui = (sid: string | null) => <PlanColumn initialSession={sid}><div data-testid="fake-canvas" /></PlanColumn>;
const handoff = (session_id: string, film_id = FILM) => act(async () => void dispatchBrainCanvas({ kind: "handoff", detail: { session_id, film_id } }));

const Y = "0f000000-0000-4000-8000-0000000000aa";
const twoScenes = {
  film: filmJson({ status: "running" }, [sceneJson(S1, 0), sceneJson("52000000-0000-4000-8000-000000000002", 1)]),
  segments: [seg],
  takes: [],
};
const setUrl = (q: string) => window.history.replaceState(null, "", `/alpha/studio?${q}`);
const urlFilm = () => new URL(document.URL).searchParams.get("film");
const stage = () => screen.getByTestId("plan-board-pane").getAttribute("data-stage");

describe("Create in place: the board morphs", () => {
  it("on the panel's handoff the same cards turn from the plan to the film: same ids, same elements, no remount", async () => {
    search = new URLSearchParams(`brain=${SID}`);
    render(ui(SID));
    await flush();
    expect(stage()).toBe("ready");
    const before = ids();
    const elBefore = new Map(before.map((id) => [id, card(id!)]));
    expect(stateOf("scene#1")).toBe("ghost");
    expect(urls.some((u) => u.endsWith("/live"))).toBe(false);

    await handoff(SID);
    await flush();
    expect(urls).toContain(`/api/films/${FILM}/live`);
    expect(stage()).toBe("making");
    // Every card the plan drew is still there, as the same element: React kept it, nothing re-entered.
    for (const [id, el] of elBefore) expect(card(id!)).toBe(el);
    // In the same order (the film adds its own steps, here its voice, where the film has them).
    expect(ids().filter((id) => before.includes(id))).toEqual(before);
    expect(stateOf("scene#1")).toBe("working");
    // The cast card the brief drew stays after Create (filmGraph draws none).
    expect(card("ref:c1")).toBeTruthy();
    // The film's voice is new and arrives; none of the plan's own cards plays its entrance again.
    const arriving = [...document.querySelectorAll<HTMLElement>("article.ds-reveal [data-node-id]")].map((el) => el.dataset.nodeId);
    expect(arriving).toContain("voice");
    expect(arriving.filter((id) => before.includes(id))).toEqual([]);
    expect(screen.getByTestId("plan-making").textContent).toBe(c.plan.making);
    expect(screen.getByTestId("plan-making").getAttribute("role")).toBe("status");
    // The film's lane mounts under the board.
    expect(document.querySelector("[data-testid=plan-live-below] [data-testid^=live-lane]")).toBeTruthy();
  });

  it("a scene card keeps the plan's cast and planned length after the morph (Lens M2), and says its state in words (Pixel M3)", async () => {
    search = new URLSearchParams(`brain=${SID}`);
    render(ui(SID));
    await flush();
    const art = () => card("scene#1").closest("article")!;
    expect(art().textContent).toContain("Aziza");
    expect(art().textContent).toContain("planned 3 s");
    await handoff(SID);
    await flush();
    expect(art().textContent).toContain("Aziza");
    expect(art().textContent).toContain("planned 3 s");
    expect(screen.getByTestId("plan-card-state-scene#1").textContent).toBe(c.plan.card.states.working);
  });

  it("a made film's idea card is not Unknown (Pixel H2)", async () => {
    search = new URLSearchParams(`brain=${SID}`);
    render(ui(SID));
    await flush();
    await handoff(SID);
    await flush();
    expect(stateOf("idea")).toBe("arrived");
    expect(card("idea").closest("article")!.textContent).not.toContain(c.plan.card.unknown);
  });

  it("the header no longer says nothing runs once started, and says reading before the film is read (Pixel H3)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    route = (url) => (url.startsWith("/api/brain/session/") ? { status: 200, body: { brief: brief() } } : { status: 200, body: filmLive });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith("/live")) await gate;
      const a = route(url);
      return new Response(JSON.stringify(a.body), { status: a.status });
    }));
    search = new URLSearchParams(`brain=${SID}`);
    render(ui(SID));
    await flush();
    expect(screen.getByTestId("plan-note").textContent).toBe(c.plan.headerNote);
    await handoff(SID);
    await flush();
    expect(screen.queryByTestId("plan-note")).toBeNull();
    expect(screen.getByTestId("plan-started").textContent).toBe(c.plan.started);
    release();
    await flush();
    await flush();
    expect(screen.getByTestId("plan-making")).toBeTruthy();
  });

  it("Create puts focus on the board's title, never on a key that leaves the page (Pixel H1)", async () => {
    search = new URLSearchParams(`brain=${SID}`);
    render(ui(SID));
    await flush();
    await handoff(SID);
    await flush();
    expect(document.activeElement).toBe(document.querySelector(".plan-title"));
  });

  it("another conversation's handoff is not this board's", async () => {
    search = new URLSearchParams(`brain=${SID}`);
    render(ui(SID));
    await flush();
    await handoff(OTHER);
    await flush();
    expect(urls.some((u) => u.endsWith("/live"))).toBe(false);
    expect(stage()).toBe("ready");
  });

  it("a film that cannot be read keeps the plan on the board and says why, in the same line", async () => {
    route = (url) => (url.startsWith("/api/brain/session/") ? { status: 200, body: { brief: brief() } } : { status: 404, body: {} });
    search = new URLSearchParams(`brain=${SID}`);
    render(ui(SID));
    await flush();
    await handoff(SID);
    await flush();
    expect(card("scene#1")).toBeTruthy();
    expect(screen.getByTestId("plan-live-notfound").textContent).toBe(c.plan.film.notFound);
    expect(document.querySelectorAll(".plan-status")).toHaveLength(1);
  });

  it("the film's activity sits folded under the lane, counts new lines, and opens itself on a failed step", async () => {
    let events: unknown[] = [{ id: 1, event: "started", created_at: "2026-11-21T10:00:00Z" }];
    route = (url) => {
      if (url.startsWith("/api/brain/session/")) return { status: 200, body: { brief: brief() } };
      const fj = filmJson({ status: "running" }, [sceneJson(S1, 0)]) as Record<string, unknown>;
      fj.events = events;
      return { status: 200, body: { film: fj, segments: [seg], takes: [] } };
    };
    search = new URLSearchParams(`brain=${SID}`);
    render(ui(SID));
    await flush();
    await handoff(SID);
    await flush();
    const details = () => screen.getByTestId("plan-activity") as HTMLDetailsElement;
    // The first reading is not news: folded, and no count.
    expect(details().open).toBe(false);
    expect(screen.getByTestId("plan-activity-new").textContent).toBe("");
    expect(screen.getByTestId("plan-activity-new").getAttribute("aria-live")).toBe("polite");
    // A later reading with a failed step: it opens by itself (reading again by showing the plan again).
    events = [...events, { id: 2, event: "take_failed", created_at: "2026-11-21T10:01:00Z", detail: { kind: "keyframe", scene_position: 0 } }];
    await act(async () => fireEvent.click(screen.getByTestId("plan-switch-canvas")));
    await act(async () => fireEvent.click(screen.getByTestId("plan-switch-plan")));
    await flush();
    await flush();
    expect(details().open).toBe(true);
  });
});

describe("Create in place: a refresh", () => {
  it("with &film= the brief names: the film's live board, its cast from the brief even when the brief is read last (Lens M3)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      if (url.startsWith("/api/brain/session/")) {
        await gate;
        return new Response(JSON.stringify({ brief: handedOff }), { status: 200 });
      }
      return new Response(JSON.stringify(filmLive), { status: 200 });
    }));
    search = new URLSearchParams(`brain=${SID}&film=${FILM}`);
    render(ui(SID));
    await flush();
    // The film is read at once, beside the brief.
    expect(urls).toContain(`/api/films/${FILM}/live`);
    release();
    await flush();
    await flush();
    expect(stage()).toBe("making");
    expect(stateOf("scene#1")).toBe("working");
    expect(card("ref:c1")).toBeTruthy();
    expect(card("scene#1").closest("article")!.textContent).toContain("Aziza");
  });

  it("&film=X while the brief names Y: reads Y, never draws X, and the URL is put right (Lens M1)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const named = brief({ status: "created", handoff: { kind: "film", film_id: Y } });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      if (url.startsWith("/api/brain/session/")) {
        await gate;
        return new Response(JSON.stringify({ brief: named }), { status: 200 });
      }
      // X has two scenes, Y one: a second scene card would be X's.
      return new Response(JSON.stringify(url.includes(FILM) ? twoScenes : filmLive), { status: 200 });
    }));
    setUrl(`brain=${SID}&film=${FILM}`);
    search = new URLSearchParams(`brain=${SID}&film=${FILM}`);
    render(ui(SID));
    await flush();
    expect(screen.queryByTestId("plan-card-scene#2")).toBeNull();
    release();
    await flush();
    await flush();
    expect(urls).toContain(`/api/films/${Y}/live`);
    expect(stage()).toBe("making");
    expect(screen.queryByTestId("plan-card-scene#2")).toBeNull();
    expect(urlFilm()).toBe(Y);
  });

  it("&film=X while the brief names no film: X is not drawn, and is taken off the URL", async () => {
    setUrl(`brain=${SID}&film=${FILM}`);
    search = new URLSearchParams(`brain=${SID}&film=${FILM}`);
    render(ui(SID));
    await flush();
    await flush();
    expect(stage()).toBe("ready");
    expect(urlFilm()).toBeNull();
  });

  it("with only ?brain= finds the film in the brief's handoff (the server's record)", async () => {
    route = (url) => (url.startsWith("/api/brain/session/") ? { status: 200, body: { brief: handedOff } } : url.endsWith("/live") ? { status: 200, body: filmLive } : { status: 404, body: {} });
    search = new URLSearchParams(`brain=${SID}`);
    render(ui(SID));
    await flush();
    await flush();
    expect(urls).toContain(`/api/films/${FILM}/live`);
    expect(stage()).toBe("making");
  });

  it("a film in the URL with no conversation is not drawn (New chat took ?brain= off)", async () => {
    search = new URLSearchParams(`film=${FILM}`);
    render(ui(null));
    await flush();
    expect(urls.some((u) => u.endsWith("/live"))).toBe(false);
  });
});

describe("only while shown", () => {
  it("behind My canvas the film is not read; shown again, it is read again with the board kept", async () => {
    search = new URLSearchParams(`brain=${SID}`);
    render(ui(SID));
    await flush();
    await handoff(SID);
    await flush();
    const reads = () => urls.filter((u) => u.endsWith("/live")).length;
    const n = reads();
    await act(async () => fireEvent.click(screen.getByTestId("plan-switch-canvas")));
    await flush();
    expect(reads()).toBe(n);
    await act(async () => fireEvent.click(screen.getByTestId("plan-switch-plan")));
    await flush();
    expect(reads()).toBe(n + 1);
    expect(stage()).toBe("making");
  });
});

describe("phone: below 1024 px", () => {
  it("Create takes the person to the Plan tab, which now draws the film's board", async () => {
    search = new URLSearchParams(`brain=${SID}`);
    render(<StudioSplit initialSession={SID} chat={<div data-testid="chat" />} column={ui(SID)} />);
    await flush();
    expect(screen.getByTestId("studio-split").getAttribute("data-tab")).toBe("chat");
    await handoff(SID);
    await flush();
    expect(screen.getByTestId("studio-split").getAttribute("data-tab")).toBe("plan");
    expect(stage()).toBe("making");
  });

  it("a refresh on ?brain=&film= opens on the Plan tab (Pixel M5)", async () => {
    route = (url) => (url.startsWith("/api/brain/session/") ? { status: 200, body: { brief: handedOff } } : { status: 200, body: filmLive });
    search = new URLSearchParams(`brain=${SID}&film=${FILM}`);
    render(<StudioSplit initialSession={SID} chat={<div data-testid="chat" />} column={ui(SID)} />);
    await flush();
    expect(screen.getByTestId("studio-split").getAttribute("data-tab")).toBe("plan");
  });
});

describe("?view=live is unchanged", () => {
  it("LiveView with a film target reads and draws it as before", async () => {
    render(<LiveView filmStudio target={{ kind: "film", id: FILM }} />);
    expect(screen.getByTestId("live-loading").textContent).toBe(c.loading);
    await screen.findByTestId("live-list");
    expect(screen.getByTestId("live-node-scene#1:keyframe").getAttribute("data-status")).toBe("working");
    expect(urls[0]).toBe(`/api/films/${FILM}/live`);
  });
});

describe("the handoff event's contract", () => {
  it("is ids only: a real session and a film UUID", () => {
    expect(isBrainHandoff({ session_id: SID, film_id: FILM })).toBe(true);
    expect(isBrainHandoff({ session_id: "", film_id: FILM })).toBe(false);
    expect(isBrainHandoff({ session_id: SID, film_id: "not-a-film" })).toBe(false);
    expect(isBrainHandoff({ session_id: null, film_id: FILM })).toBe(false);
    expect(dispatchBrainCanvas({ kind: "handoff", detail: { session_id: SID, film_id: "x" } })).toBe(false);
  });
});

describe("timing marks", () => {
  it("a board is lit by a working step or a made one, not by the idea and script a film has from the start", () => {
    const g = (nodes: Partial<LiveNode>[]) => ({ nodes: nodes.map((n, i) => ({ id: `n${i}`, col: 0, row: 0, ...n })), edges: [] }) as unknown as LiveGraph;
    expect(hasLitStep(g([{ kind: "idea", status: "done" }, { kind: "script", status: "done" }, { kind: "keyframe", status: "waiting" }]))).toBe(false);
    expect(hasLitStep(g([{ kind: "character", status: "done" }]))).toBe(false);
    expect(hasLitStep(g([{ kind: "keyframe", status: "working" }]))).toBe(true);
    expect(hasLitStep(g([{ kind: "clip", status: "done" }]))).toBe(true);
    // A key frame done at the film's first reading (made from an existing file) is not a step that lit.
    expect(hasLitStep(g([{ kind: "keyframe", status: "done" }]), new Set(["n0"]))).toBe(false);
  });

  it("each fires once through the flow: plan card, then live card, then the first lit step", async () => {
    search = new URLSearchParams(`brain=${SID}`);
    render(ui(SID));
    await flush();
    await handoff(SID);
    await flush();
    nsMarkOnce("ns:create:confirm");
    nsMarkOnce("ns:create:confirm");
    expect(marks.filter((m) => m === "ns:plan:first-card")).toHaveLength(1);
    expect(marks.filter((m) => m === "ns:live:first-card")).toHaveLength(1);
    expect(marks.filter((m) => m === "ns:live:first-lit")).toHaveLength(1);
    expect(marks.filter((m) => m === "ns:create:confirm")).toHaveLength(1);
    expect(marks.indexOf("ns:plan:first-card")).toBeLessThan(marks.indexOf("ns:live:first-card"));
  });

  it("ns:create:confirm fires from useFilmStart.confirm itself, once, when the person confirms", async () => {
    const { useFilmStart } = await import("../lib/studio/useFilmStart");
    const { coerceQuote } = await import("../lib/studio/timeline");
    const quote = coerceQuote({ priced: true, total: 40, quote_id: `fq-2-${"a".repeat(32)}`, startable: true, may_start: true, available: 500 });
    route = () => ({ status: 200, body: { start: { ok: true, replayed: false } } });
    const h = renderHook(() => useFilmStart({ filmId: FILM, quote, onStarted: () => {} }));
    expect(marks).not.toContain("ns:create:confirm");
    act(() => h.result.current.press());
    expect(marks).not.toContain("ns:create:confirm");
    await act(async () => h.result.current.confirm());
    await act(async () => h.result.current.confirm());
    expect(marks.filter((m) => m === "ns:create:confirm")).toHaveLength(1);
  });

  it("the storyboard mark fires on the storyboard phase, once", async () => {
    search = new URLSearchParams(`brain=${SID}`);
    render(ui(SID));
    await flush();
    await act(async () => void dispatchBrainCanvas({ kind: "activity", detail: { session_id: SID, phase: "planning" } }));
    await act(async () => void dispatchBrainCanvas({ kind: "activity", detail: { session_id: SID, phase: "end" } }));
    await act(async () => void dispatchBrainCanvas({ kind: "activity", detail: { session_id: SID, phase: "planning" } }));
    expect(marks.filter((m) => m === "ns:plan:storyboard-start")).toHaveLength(1);
  });

  it("never throws: no performance, no mark, or a mark that throws", () => {
    vi.restoreAllMocks();
    vi.spyOn(performance, "mark").mockImplementation(() => {
      throw new Error("refused");
    });
    expect(() => nsMarkOnce("ns:test:throws")).not.toThrow();
    vi.stubGlobal("performance", undefined);
    expect(() => nsMarkOnce("ns:test:missing")).not.toThrow();
    vi.stubGlobal("performance", {});
    expect(() => nsMarkOnce("ns:test:nomark")).not.toThrow();
  });
});
