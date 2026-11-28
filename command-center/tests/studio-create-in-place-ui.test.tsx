// @vitest-environment jsdom
/**
 * Create in place (docs/studio/LIVE_CREATION_PLAN.md §3.9, item 9). Measured before: after the person confirmed Create, the panel
 * reloaded the page into `?view=live&film=`: 0.35 s with no page, then a page without the panel, and the first live card 1.2–1.5 s
 * after confirm. What would break without these: the board remounting its cards at Create (the plan the person confirmed vanishing
 * and coming back), a refresh after Create losing the film, a refresh with only ?brain= not finding the film the server recorded,
 * another conversation's film drawn under this one, and the timing marks throwing or firing more than once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { studioLiveEn as c } from "../lib/i18n/studio-live/en";
import { clearBrainActivity, dispatchBrainCanvas, isBrainHandoff } from "../lib/studio/brainActivity";
import { nsMarkOnce, resetNsMarks } from "../lib/studio/nsMark";
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

describe("Create in place: the board morphs", () => {
  it("on the panel's handoff the same cards turn from the plan to the film: same ids, same elements, no remount", async () => {
    search = new URLSearchParams(`brain=${SID}`);
    render(ui(SID));
    await flush();
    expect(screen.getByTestId("plan-board-pane").getAttribute("data-stage")).toBe("ready");
    const before = ids();
    const elBefore = new Map(before.map((id) => [id, card(id!)]));
    expect(stateOf("scene#1")).toBe("ghost");
    expect(urls.some((u) => u.endsWith("/live"))).toBe(false);

    await handoff(SID);
    await flush();
    expect(urls).toContain(`/api/films/${FILM}/live`);
    expect(screen.getByTestId("plan-board-pane").getAttribute("data-stage")).toBe("making");
    // Every card the plan drew is still there, as the same element: React kept it, nothing re-entered.
    for (const [id, el] of elBefore) expect(card(id!)).toBe(el);
    // In the same order (the film adds its own steps, here its voice, where the film has them).
    expect(ids().filter((id) => before.includes(id))).toEqual(before);
    expect(stateOf("scene#1")).toBe("working");
    // The cast card the brief drew stays after Create (filmGraph draws none).
    expect(card("ref:c1")).toBeTruthy();
    // Only a step the plan did not have (the film's voice) arrives; none of the plan's own cards plays its entrance again.
    const arriving = [...document.querySelectorAll<HTMLElement>("article.ds-reveal [data-node-id]")].map((el) => el.dataset.nodeId);
    expect(arriving.filter((id) => before.includes(id))).toEqual([]);
    expect(screen.getByTestId("plan-making").textContent).toBe(c.plan.making);
    // The film's lane mounts under the board.
    expect(document.querySelector(".lane-strip, [data-testid^=live-lane]")).toBeTruthy();
  });

  it("another conversation's handoff is not this board's", async () => {
    search = new URLSearchParams(`brain=${SID}`);
    render(ui(SID));
    await flush();
    await handoff(OTHER);
    await flush();
    expect(urls.some((u) => u.endsWith("/live"))).toBe(false);
    expect(screen.getByTestId("plan-board-pane").getAttribute("data-stage")).toBe("ready");
  });

  it("a film that cannot be read keeps the plan on the board and says why", async () => {
    route = (url) => (url.startsWith("/api/brain/session/") ? { status: 200, body: { brief: brief() } } : { status: 404, body: {} });
    search = new URLSearchParams(`brain=${SID}`);
    render(ui(SID));
    await flush();
    await handoff(SID);
    await flush();
    expect(card("scene#1")).toBeTruthy();
    expect(screen.getByTestId("plan-live-notfound").textContent).toBe(c.notFound);
  });
});

describe("Create in place: a refresh", () => {
  it("with &film= in the URL draws the film's live board, without any event", async () => {
    search = new URLSearchParams(`brain=${SID}&film=${FILM}`);
    render(ui(SID));
    await flush();
    expect(urls).toContain(`/api/films/${FILM}/live`);
    expect(screen.getByTestId("plan-board-pane").getAttribute("data-stage")).toBe("making");
    expect(stateOf("scene#1")).toBe("working");
  });

  it("with only ?brain= finds the film in the brief's handoff (the server's record)", async () => {
    route = (url) => (url.startsWith("/api/brain/session/") ? { status: 200, body: { brief: handedOff } } : url.endsWith("/live") ? { status: 200, body: filmLive } : { status: 404, body: {} });
    search = new URLSearchParams(`brain=${SID}`);
    render(ui(SID));
    await flush();
    await flush();
    expect(urls).toContain(`/api/films/${FILM}/live`);
    expect(screen.getByTestId("plan-board-pane").getAttribute("data-stage")).toBe("making");
  });

  it("a film in the URL with no conversation is not drawn (New chat took ?brain= off)", async () => {
    search = new URLSearchParams(`film=${FILM}`);
    render(ui(null));
    await flush();
    expect(urls.some((u) => u.endsWith("/live"))).toBe(false);
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
    expect(screen.getByTestId("plan-board-pane").getAttribute("data-stage")).toBe("making");
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
