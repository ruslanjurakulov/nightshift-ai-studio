// @vitest-environment jsdom
/**
 * The lane under a live film (components/studio-live/LiveLane) on screen. What would break without these: a piece "flying" on the
 * first reading or after a reload (a refresh replaying every landing), a length nobody knows printed as a number, a master offering a
 * download before a file exists, a press on a piece that writes anything, the transport inventing a total, a project with no scenes
 * drawn as a blank strip, and the lane showing under a channel run (it is a film's).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { studioLiveEn as c } from "../lib/i18n/studio-live/en";
import { fmt } from "../lib/i18n";
import { coerceFilmLive, filmGraph } from "../lib/studio/liveGraph";
import type { LiveLoad } from "../components/studio-live/useLiveGraph";
import { FILM, S1, S2, filmJson, sceneJson } from "./films-fixtures";

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
vi.mock("next/navigation", () => ({ usePathname: () => "/alpha/studio", useRouter: () => ({ refresh() {} }) }));

const { LiveLane, nodeOfPiece } = await import("../components/studio-live/LiveLane");
const { LiveView } = await import("../components/studio-live/LiveView");

const C1 = "c1000000-0000-4000-8000-0000000000c1";
const C2 = "c2000000-0000-4000-8000-0000000000c2";
const MP4 = "f1000000-0000-4000-8000-0000000000f1";
const KEY = `film:${FILM}`;
let calls: { method: string; url: string }[] = [];
let phone = false;

beforeEach(() => {
  calls = [];
  phone = false;
  window.localStorage.clear();
  // Reduced motion on: the strip still marks what landed (is-new) but flies no tag, which keeps jsdom out of layout.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") || (phone && q.includes("767")) || q.includes("1279"), media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url });
      // The library answers each landed file with its measured length (no signed links: this server serves none).
      const id = decodeURIComponent(url.split("/").pop() ?? "");
      const d = id === C1 ? 8 : id === C2 ? 6 : id === MP4 ? 14 : null;
      return new Response(JSON.stringify({ asset: { id, kind: "video", durationS: d }, urls: {}, served: false }), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const take = (id: string, kind: string, status: string, over: Record<string, unknown> = {}) => ({
  id, kind, status, version: 1, shot_index: kind === "keyframe" || kind === "narration" ? 0 : 1, attempt: 1, duration_s: null, result_asset_id: null, ...over,
});
const seg = (over: Record<string, unknown> = {}) => ({
  id: "seg1", status: "running", assembly_status: "planned", assembly_asset_id: null, confirmed_credits: 40, captured_credits: null,
  assembly_confirmed_credits: 8, assembly_charged_credits: null, created_at: "2026-11-21T00:00:00Z", ...over,
});
type Step = { status: string; s1?: unknown[]; s2?: unknown[]; narration?: unknown[]; segment?: Record<string, unknown>; scenes?: boolean };
function body(s: Step) {
  const scenes = s.scenes === false ? [] : [sceneJson(S1, 0, { current_version: 1, planned_seconds: 8, takes: s.s1 ?? [] }), sceneJson(S2, 1, { current_version: 1, planned_seconds: 6, takes: s.s2 ?? [] })];
  return { film: { ...filmJson({ status: s.status }, scenes), takes: s.narration ?? [] }, segments: [seg(s.segment)], takes: [] };
}
function loadOf(s: Step): LiveLoad {
  const film = coerceFilmLive(body(s));
  if (!film) throw new Error("fixture did not coerce");
  return { state: "ready", graph: filmGraph(film), film, key: KEY };
}
const QUEUED: Step = { status: "queued" };
const TWO_CLIPS: Step = { status: "running", s1: [take("t1", "clip", "completed", { result_asset_id: C1 })], s2: [take("t2", "clip", "running")], narration: [take("n1", "narration", "running", { duration_s: 14 })] };
const MORE: Step = { ...TWO_CLIPS, s2: [take("t2", "clip", "completed", { result_asset_id: C2 })] };
const READY: Step = { ...MORE, status: "ready", narration: [take("n1", "narration", "completed", { duration_s: 14 })], segment: { status: "settled", assembly_status: "completed", assembly_asset_id: MP4, assembly_charged_credits: 8 } };

const lane = (load: LiveLoad, over: Partial<Parameters<typeof LiveLane>[0]> = {}) => (
  <LiveLane load={load} planKey={KEY} stale={false} selected={null} onOpen={() => {}} retry={() => {}} {...over} />
);
const fresh = () => document.querySelectorAll("[data-testid=live-lane] .is-new").length;
const seg1 = () => screen.getByTestId(`lane-seg-v:${S1}:1`);
const seg2 = () => screen.getByTestId(`lane-seg-v:${S2}:1`);
const announced = () => screen.getByTestId("live-lane-announce").textContent;

describe("states", () => {
  it("loading draws a busy skeleton and an error a line with 'Try now', neither a second status region (LiveView owns those)", () => {
    const retry = vi.fn();
    const { rerender } = render(lane({ state: "loading" }, { retry }));
    expect(screen.getByTestId("live-lane-loading")).toBeTruthy();
    expect(screen.getByTestId("live-lane").getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector("[data-testid=live-lane] [role=status], [data-testid=live-lane] [role=alert]")).toBeNull();
    rerender(lane({ state: "error" }, { retry }));
    expect(screen.getByTestId("live-lane-error").textContent).toBe(c.lane.error);
    expect(document.querySelector("[data-testid=live-lane] [role=status], [data-testid=live-lane] [role=alert]")).toBeNull();
    fireEvent.click(screen.getByTestId("live-lane-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("an empty project hides the clock and the count, and says so with a way to its editor", () => {
    render(lane(loadOf({ status: "draft", scenes: false })));
    expect(screen.getByTestId("live-lane-empty").textContent).toContain(c.lane.empty);
    expect(screen.getByTestId("live-lane-editor").getAttribute("href")).toBe(`/alpha/studio?view=timeline&film=${FILM}`);
    expect(screen.queryByTestId("live-lane-clock")).toBeNull();
    expect(screen.queryByTestId("live-lane-made")).toBeNull();
    expect(screen.queryByTestId("live-lane-strip")).toBeNull();
  });

  it("a reading of another plan (one render after a switch) is not drawn: it is loading, not that plan's lane", () => {
    render(lane({ ...loadOf(TWO_CLIPS), key: "film:someone-else" } as LiveLoad));
    expect(screen.getByTestId("live-lane-loading")).toBeTruthy();
  });

  it("stale says when the last reading was; the phone width draws the phone strip", () => {
    phone = true;
    render(lane(loadOf(QUEUED), { stale: true }));
    expect(screen.getByTestId("live-lane-stale").textContent).toMatch(/^Last reading \d/);
    expect(screen.getByTestId("live-lane-strip").className).toContain("is-phone");
  });

  it("on a phone with the strip closed, the master is still on screen", () => {
    phone = true;
    render(lane(loadOf(READY)));
    expect(screen.getByTestId("live-lane-strip").dataset.open).toBe("false");
    expect(screen.getByTestId("lane-master")).toBeTruthy();
    expect(screen.getByTestId("live-lane-download")).toBeTruthy();
  });
});

describe("the progress row", () => {
  it("one total only, marked 'plan' while it is the plan; the clock is labelled 'Made' and has no playhead flag", () => {
    render(lane(loadOf(QUEUED)));
    const total = screen.getByTestId("live-lane-total");
    expect(total.textContent).toContain("00:00:14:00");
    expect(total.textContent).toContain(c.lane.planTag);
    expect(total.dataset.basis).toBe("planned");
    // The strip's own total is off: the page says one length, not two.
    expect(screen.queryByTestId("lane-total")).toBeNull();
    expect(screen.getByTestId("live-lane-transport").textContent).toContain(c.lane.madeTag);
    expect(document.querySelector("[data-testid=live-lane] .cv-lane-head")).toBeNull();
    expect(screen.getByTestId("live-lane-status").textContent).toBe(c.lane.film.queued);
    // Two clips, the narration (queued films have it pending) and the master.
    expect(screen.getByTestId("live-lane-made").textContent).toBe("0 of 4 pieces made");
  });

  it("once the master is ready and measured, the total is its file's length, no longer the plan", async () => {
    render(lane(loadOf(READY)));
    await vi.waitFor(() => expect(screen.getByTestId("live-lane-total").dataset.basis).toBe("measured"));
    expect(screen.getByTestId("live-lane-total").textContent).toContain("00:00:14:00");
    expect(screen.getByTestId("live-lane-total").textContent).not.toContain(c.lane.planTag);
  });

  it("a total nobody planned is '?', never a number", () => {
    const r = loadOf(QUEUED) as Extract<LiveLoad, { state: "ready" }>;
    const film = coerceFilmLive({ ...body(QUEUED), film: { ...filmJson({ status: "queued" }, [sceneJson(S1, 0, { planned_seconds: 0 })]), takes: [] } })!;
    render(lane({ ...r, film, graph: filmGraph(film) }));
    expect(screen.getByTestId("live-lane-total").textContent).toContain("?");
    expect(screen.getByTestId("live-lane-total").textContent).not.toMatch(/\d/);
  });

  it("there is no play button: nothing plays until there is a file", () => {
    render(lane(loadOf(TWO_CLIPS)));
    expect(within(screen.getByTestId("live-lane-transport")).queryByRole("button")).toBeNull();
  });
});

describe("pills", () => {
  it("say their tag on their face, with the full name in the accessible name", () => {
    render(lane(loadOf(TWO_CLIPS)));
    expect(seg1().querySelector(".cv-pill-nm")!.textContent).toBe("clip-01");
    expect(seg1().getAttribute("aria-label")).toContain(fmt(c.kinds.clip, { n: 1 }));
    expect(screen.getByTestId("live-lane-strip").getAttribute("aria-label")).toBe(c.lane.label);
  });
});

describe("pieces landing", () => {
  it("the first reading flies nothing; the next marks only the piece that landed and says it once", async () => {
    const { rerender } = render(lane(loadOf(QUEUED)));
    expect(fresh()).toBe(0);
    expect(announced()).toBe("");
    rerender(lane(loadOf(TWO_CLIPS)));
    await vi.waitFor(() => expect(seg1().className).toContain("is-new"));
    expect(seg2().className).not.toContain("is-new");
    expect(announced()).toBe(fmt(c.lane.landedSr, { names: fmt(c.kinds.clip, { n: 1 }) }));
    // A poll with nothing new (a new reading object, the same rows): nothing more lands, and the line clears.
    rerender(lane(loadOf(TWO_CLIPS)));
    expect(announced()).toBe("");
  });

  it("a reload in the middle restores the lane with nothing flying, though the reading has moved on since the last one seen", () => {
    const first = render(lane(loadOf(QUEUED)));
    first.rerender(lane(loadOf(TWO_CLIPS)));
    first.unmount();
    // In the same session MORE would fly scene 2; after a reload it is simply there.
    render(lane(loadOf(MORE)));
    expect(fresh()).toBe(0);
    expect(seg2().dataset.length).not.toBe("unknown");
    expect(seg2().className).toContain("is-made");
    expect(announced()).toBe("");
  });

  it("a film switch flies nothing, even when the other film's clips are landed", () => {
    const OTHER = "0f000000-0000-4000-8000-0000000000ee";
    const { rerender } = render(lane(loadOf(QUEUED)));
    const film = coerceFilmLive({ ...body(MORE), film: { ...body(MORE).film, film: { ...body(MORE).film.film, id: OTHER } } })!;
    rerender(lane({ state: "ready", graph: filmGraph(film), film, key: `film:${OTHER}` }, { planKey: `film:${OTHER}` }));
    expect(fresh()).toBe(0);
    expect(announced()).toBe("");
  });

  it("a stale read (the same reading kept on screen) flies nothing again", () => {
    const queued = loadOf(QUEUED);
    const two = loadOf(TWO_CLIPS);
    const { rerender } = render(lane(queued));
    rerender(lane(two));
    expect(announced()).not.toBe("");
    rerender(lane(two, { stale: true }));
    rerender(lane(two, { stale: true }));
    expect(announced()).not.toBe("");
    expect(screen.getByTestId("live-lane-stale")).toBeTruthy();
  });

  it("a pending piece's planned share is drawn as 'plan', a landed clip as its measured length once the library answers", async () => {
    render(lane(loadOf(TWO_CLIPS)));
    expect(seg2().dataset.length).toBe("planned");
    // Scene 1's only shot is landed and measured (8 s): it is where the worker cuts it.
    await vi.waitFor(() => expect(seg1().dataset.length).toBe("measured"));
  });

  it("a press on a piece opens its step and writes nothing; closing the step gives focus back to that pill", () => {
    const onOpen = vi.fn();
    const { rerender } = render(lane(loadOf(TWO_CLIPS), { onOpen }));
    fireEvent.click(seg2());
    expect(onOpen).toHaveBeenCalledWith(`scene#2:clip`);
    rerender(lane(loadOf(TWO_CLIPS), { onOpen, selected: `scene#2:clip` }));
    rerender(lane(loadOf(TWO_CLIPS), { onOpen, selected: null }));
    expect(document.activeElement).toBe(seg2());
    fireEvent.click(screen.getByTestId("lane-seg-a:narration"));
    expect(onOpen).toHaveBeenLastCalledWith("voice");
    expect(calls.every((x) => x.method === "GET")).toBe(true);
  });
});

describe("the master", () => {
  it("not assembled yet: its words, and no download without a file", () => {
    render(lane(loadOf(TWO_CLIPS)));
    const cell = screen.getByTestId("lane-master");
    expect(cell.textContent).toContain(c.lane.master.pending);
    expect(screen.queryByTestId("live-lane-download")).toBeNull();
    expect(screen.getByTestId("live-lane-nofile").textContent).toBe(c.lane.master.noFile);
  });

  it("ready with its file: 'Final video', the existing download, and an accessible name with no position number", () => {
    render(lane(loadOf(READY)));
    const cell = screen.getByTestId("lane-master");
    expect(cell.textContent).toContain(c.lane.master.name);
    expect(cell.textContent).toContain(c.lane.master.ready);
    expect(screen.getByTestId("live-lane-download")).toBeTruthy();
    expect(screen.getByTestId("lane-seg-m:master").getAttribute("aria-label")).not.toMatch(/^\d/);
  });

  it("a completed assembly without a file offers no download and says it cannot be read, not 'until it is assembled'", () => {
    render(lane(loadOf({ ...MORE, status: "ready", segment: { status: "settled", assembly_status: "completed", assembly_asset_id: null, assembly_charged_credits: 8 } })));
    expect(screen.queryByTestId("live-lane-download")).toBeNull();
    expect(screen.getByTestId("live-lane-unknown").textContent).toBe(c.lane.master.unknownNote);
    expect(screen.queryByTestId("live-lane-nofile")).toBeNull();
  });

  it("assembling says so; failed says 'Failed' and its reason in words, with the remedy as text; pressing it opens the assembly", () => {
    const onOpen = vi.fn();
    const { rerender } = render(lane(loadOf({ ...MORE, segment: { assembly_status: "running" } }), { onOpen }));
    expect(screen.getByTestId("lane-master").textContent).toContain(c.lane.master.assembling);
    rerender(lane(loadOf({ ...MORE, status: "failed", segment: { status: "settled", assembly_status: "failed", assembly_charged_credits: 0 } }), { onOpen }));
    const text = screen.getByTestId("lane-master").textContent!;
    expect(text).toContain(fmt(c.lane.failedWith, { state: c.lane.state.failed, reason: c.lane.assembly.reasons.assembly_failed }));
    expect(text).not.toContain("assembly_failed");
    expect(screen.getByTestId("live-lane-remedy").textContent).toBe(c.lane.assembly.remedyAgain);
    expect(screen.getByTestId("live-lane-remedy").closest("button")).toBeNull();
    expect(screen.queryByTestId("live-lane-download")).toBeNull();
    fireEvent.click(screen.getByTestId("lane-seg-m:master"));
    expect(onOpen).toHaveBeenCalledWith("assembly");
  });
});

describe("in the live view", () => {
  it("a film's view mounts the lane under its steps; a channel run's does not", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.includes("/live") ? new Response(JSON.stringify(body(TWO_CLIPS)), { status: 200 }) : new Response(JSON.stringify({ urls: {}, served: false }), { status: 200 }))),
    );
    const { unmount } = render(<LiveView filmStudio target={{ kind: "film", id: FILM }} />);
    await screen.findByTestId("live-lane-strip");
    const list = screen.getByTestId("live-list");
    expect(list.compareDocumentPosition(screen.getByTestId("live-lane")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ job: null }), { status: 200 })));
    render(<LiveView filmStudio target={{ kind: "run", id: "42" }} />);
    expect(screen.queryByTestId("live-lane")).toBeNull();
  });
});

describe("a piece and its board card (position-keyed ids)", () => {
  it("every clip piece names a card the board has, by the scene's position, never by the film's scene id", async () => {
    const load = loadOf(TWO_CLIPS);
    if (load.state !== "ready" || !load.film) throw new Error("fixture");
    const { liveLane } = await import("../lib/studio/liveLane");
    const l = liveLane(load.film, new Map());
    const sceneNo = new Map(l.video.map((p) => [p.sceneId, p.scene] as const));
    const ids = new Set(load.graph.nodes.map((n) => n.id));
    expect(l.video.map((p) => nodeOfPiece(p.id, null, sceneNo))).toEqual(["scene#1:clip", "scene#2:clip"]);
    for (const p of l.video) expect(ids.has(nodeOfPiece(p.id, null, sceneNo)!)).toBe(true);
    // A scene the lane does not place has no card to name (not a guessed one).
    expect(nodeOfPiece(`v:${S2}:1`)).toBeNull();
  });

  it("a press on scene 2's pill opens the board card the lane's flights start from (data-node-id)", () => {
    const onOpen = vi.fn();
    render(
      <>
        <div className="lv-board">
          <button type="button" data-node-id="scene#2:clip">card</button>
        </div>
        {lane(loadOf(TWO_CLIPS), { onOpen })}
      </>,
    );
    fireEvent.click(seg2());
    const id = onOpen.mock.calls[0][0] as string;
    expect(document.querySelector(`.lv-board [data-node-id="${id}"]`)).not.toBeNull();
  });
});
