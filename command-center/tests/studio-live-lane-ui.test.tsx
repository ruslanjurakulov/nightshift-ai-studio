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

const { LiveLane } = await import("../components/studio-live/LiveLane");
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

const lane = (load: LiveLoad, over: Partial<Parameters<typeof LiveLane>[0]> = {}) => <LiveLane load={load} planKey={KEY} stale={false} selected={null} onOpen={() => {}} {...over} />;
const fresh = () => document.querySelectorAll("[data-testid=live-lane] .cv-pill.is-new").length;
const seg1 = () => screen.getByTestId(`lane-seg-v:${S1}:1`);
const seg2 = () => screen.getByTestId(`lane-seg-v:${S2}:1`);

describe("states", () => {
  it("loading draws a skeleton, an error says so, an empty project says it has no scenes", () => {
    const { rerender } = render(lane({ state: "loading" }));
    expect(screen.getByTestId("live-lane-loading")).toBeTruthy();
    rerender(lane({ state: "error" }));
    expect(screen.getByTestId("live-lane-error").textContent).toBe(c.lane.error);
    rerender(lane(loadOf({ status: "draft", scenes: false })));
    expect(screen.getByTestId("live-lane-empty").textContent).toBe(c.lane.empty);
    expect(screen.queryByTestId("live-lane-strip")).toBeNull();
  });

  it("a reading of another plan (one render after a switch) is not drawn: it is loading, not that plan's lane", () => {
    render(lane({ ...loadOf(TWO_CLIPS), key: "film:someone-else" } as LiveLoad));
    expect(screen.getByTestId("live-lane-loading")).toBeTruthy();
  });

  it("stale shows the view's last-reading word; the phone width draws the phone strip", () => {
    phone = true;
    render(lane(loadOf(QUEUED), { stale: true }));
    expect(screen.getByTestId("live-lane-stale").textContent).toBe(c.lane.stale);
    expect(screen.getByTestId("live-lane-strip").className).toContain("is-phone");
  });
});

describe("the transport", () => {
  it("before anything is made: the clock is the plan's total with nothing landed, the film's status in words, 0 of N made", async () => {
    render(lane(loadOf(QUEUED)));
    expect(screen.getByTestId("live-lane-clock").textContent).toContain("00:00:00:00 / 00:00:14:00");
    expect(screen.getByTestId("live-lane-status").textContent).toBe(c.lane.film.queued);
    // Two clips, the narration (queued films have it pending) and the master.
    expect(screen.getByTestId("live-lane-made").textContent).toBe("0 of 4 pieces made");
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

describe("pieces landing", () => {
  it("the first reading flies nothing; the next marks only the piece that landed; a reload in the middle restores it with none", async () => {
    const { rerender, unmount } = render(lane(loadOf(QUEUED)));
    expect(fresh()).toBe(0);
    rerender(lane(loadOf(TWO_CLIPS)));
    await screen.findByText((_, el) => !!el?.classList?.contains("is-new"));
    expect(seg1().className).toContain("is-new");
    expect(seg2().className).not.toContain("is-new");
    unmount();
    // A reload: a new mount, its first reading already has both clips landed.
    render(lane(loadOf(MORE)));
    expect(fresh()).toBe(0);
    expect(seg1().dataset.length).not.toBe("unknown");
  });

  it("a pending piece's planned share is drawn as 'plan', a landed clip as its measured length once the library answers", async () => {
    render(lane(loadOf(TWO_CLIPS)));
    expect(seg2().dataset.length).toBe("planned");
    // Scene 1's only shot is landed and measured (8 s): it is where the worker cuts it.
    await vi.waitFor(() => expect(seg1().dataset.length).toBe("measured"));
  });

  it("a press on a piece opens its step on the board and writes nothing", () => {
    const onOpen = vi.fn();
    render(lane(loadOf(TWO_CLIPS), { onOpen }));
    fireEvent.click(seg2());
    expect(onOpen).toHaveBeenCalledWith(`scene:${S2}:clip`);
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

  it("ready with its file: 'Final film', and the existing download", () => {
    render(lane(loadOf(READY)));
    const cell = screen.getByTestId("lane-master");
    expect(cell.textContent).toContain(c.lane.master.name);
    expect(cell.textContent).toContain(c.lane.master.ready);
    expect(screen.getByTestId("live-lane-download")).toBeTruthy();
  });

  it("assembling says so; failed carries the reason", () => {
    const { rerender } = render(lane(loadOf({ ...MORE, segment: { assembly_status: "running" } })));
    expect(screen.getByTestId("lane-master").textContent).toContain(c.lane.master.assembling);
    rerender(lane(loadOf({ ...MORE, status: "failed", segment: { status: "settled", assembly_status: "failed", assembly_charged_credits: 0 } })));
    expect(screen.getByTestId("lane-master").textContent).toContain(c.lane.assembly.reasons.assembly_failed);
    expect(screen.getByTestId("lane-master").textContent).not.toContain("assembly_failed");
    // The remedy is words under the cell, not a key that re-runs anything.
    expect(screen.getByTestId("live-lane-remedy").textContent).toBe(c.lane.assembly.remedy);
    expect(screen.getByTestId("live-lane-remedy").closest("button")).toBeNull();
    expect(screen.queryByTestId("live-lane-download")).toBeNull();
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
