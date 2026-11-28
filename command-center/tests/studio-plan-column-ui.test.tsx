// @vitest-environment jsdom
/**
 * The Studio's Plan column beside Nightshift AI (components/studio-live/PlanColumn.tsx). Measured on main, the canvas beside the chat
 * never changed during a conversation (docs/studio/S3_LIVE_MEASURE.md). What would break without these: a message that leaves the
 * person on their canvas with the plan nowhere, a switch back that loses what was on their canvas, a storyboard wait with nothing on
 * screen, cards that move under reduced motion, and a failed re-read that blanks the plan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Profiler, useContext, useState, type ReactNode } from "react";
import { CanvasActiveContext } from "../components/studio-canvas/canvasActive";
import { studioLiveEn as c } from "../lib/i18n/studio-live/en";
import { clearBrainActivity, dispatchBrainCanvas, type BrainActivity } from "../lib/studio/brainActivity";
import { VIEW_MEMORY_KEY } from "../lib/studio/planBoard";

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

const A = "5e550000-0000-4000-8000-0000000000e1";
const B = "5e550000-0000-4000-8000-0000000000e2";
const drafting = { version: 1, status: "drafting", kind: "short", voice: { mode: "off" }, music: { mode: "off" } };
const withScenes = (n: number) => ({
  ...drafting,
  status: "ready",
  title: "The kite that came back",
  characters: [{ id: "c1", name: "Aziza" }],
  scenes: Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, n: i + 1, title: `Shot ${i + 1}`, visual_prompt: `The kite, shot ${i + 1}\nmore`, duration_s: 3, character_ids: ["c1"] })),
});

let answers: { status: number; body: unknown }[] = [];
let reads = 0;
let reduce = false;
let readUrls: string[] = [];
let byUrl: ((url: string) => { status: number; body: unknown } | null) | null = null;

beforeEach(() => {
  search = new URLSearchParams();
  answers = [];
  reads = 0;
  reduce = false;
  readUrls = [];
  byUrl = null;
  window.localStorage.clear();
  // Phone width (the board is React Flow's, measured by a browser): the same cards as a list.
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q.includes("max-width") || (q.includes("reduce") && reduce),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      reads++;
      readUrls.push(url);
      const a = (byUrl && byUrl(url)) ?? answers.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(a.body), { status: a.status });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // The page remembers the last activity for late listeners (brainActivity replay): each test starts from a quiet panel.
  clearBrainActivity();
});

/** The person's own canvas: it has cards, and a count only kept if it is never unmounted. */
function FakeCanvas() {
  const [n, setN] = useState(0);
  return (
    <div data-testid="fake-canvas">
      <span data-testid="fake-nodes">3 cards</span>
      <button type="button" onClick={() => setN((x) => x + 1)}>
        edits {n}
      </button>
    </div>
  );
}
const briefDone = (sid: string) => act(async () => void window.dispatchEvent(new CustomEvent("nightshift:brain-brief", { detail: { session_id: sid } })));
// Sent as the panel sends it: a detail that breaks #989's contract (a null session on anything but "thinking") is never sent.
const activity = (session_id: string | null, phase: BrainActivity["phase"], plan?: BrainActivity["plan"]) =>
  act(async () => void dispatchBrainCanvas({ kind: "activity", detail: (plan ? { session_id, phase, plan } : { session_id, phase }) as BrainActivity }));
// A read resolves, then the board commits its model on the next animation frame (useBoardModel batches per frame).
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => setTimeout(r, 0));
  });
const canvasPane = () => screen.getByTestId("plan-canvas-pane");

const pane = () => screen.queryByTestId("plan-board-pane");
const card = (id: string) => screen.getByTestId(`plan-card-${id}`);
const arriving = () => [...document.querySelectorAll<HTMLElement>("article.ds-reveal [data-node-id]")].map((el) => el.dataset.nodeId);
const ui = (initial: string | null) => <PlanColumn initialSession={initial}><FakeCanvas /></PlanColumn>;
const openOn = async (sid: string, ...briefs: unknown[]) => {
  answers.push(...briefs.map((brief) => ({ status: 200, body: { brief } })));
  search = new URLSearchParams(`brain=${sid}`);
  const r = render(ui(sid));
  await flush();
  return r;
};

describe("Plan column: switching", () => {
  it("sending switches the column to the plan, even with cards on the person's canvas, and says so", async () => {
    render(ui(null));
    expect(screen.getByTestId("fake-nodes")).toBeTruthy();
    expect(canvasPane().hasAttribute("inert")).toBe(false);
    expect(pane()).toBeNull();
    await activity(null, "thinking");
    expect(pane()).toBeTruthy();
    expect(screen.getByTestId("plan-thinking").textContent).toContain(c.plan.planning);
    expect(canvasPane().hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("plan-switch-plan").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("plan-announce").textContent).toContain(c.plan.autoShown);
    // The turn's answer: the column reads the conversation once and draws its cards.
    answers.push({ status: 200, body: { brief: drafting } });
    await briefDone(A);
    await flush();
    expect(reads).toBe(1);
    expect(card("idea")).toBeTruthy();
  });

  it("the switch (a tablist, arrow keys) returns to the canvas as it was; the choice holds for this conversation only", async () => {
    await openOn(A, drafting);
    fireEvent.click(screen.getByText("edits 0"));
    expect(pane()).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("plan-switch-plan"), { key: "ArrowRight" });
    expect(pane()).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("plan-switch-canvas"));
    expect(canvasPane().hasAttribute("inert")).toBe(false);
    expect(screen.getByText("edits 1")).toBeTruthy();
    await activity(A, "thinking");
    expect(pane()).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(VIEW_MEMORY_KEY) ?? "null")).toEqual({ session: A, view: "canvas" });
    await activity(null, "thinking");
    expect(pane()).toBeTruthy();
    expect(screen.getByText("edits 1")).toBeTruthy();
  });

  it("storage that throws: the switch still works for this page (Lens N1)", async () => {
    const real = window.localStorage;
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => { throw new Error("denied"); } });
    try {
      render(ui(null));
      await activity(null, "thinking");
      expect(pane()).toBeTruthy();
      fireEvent.click(screen.getByTestId("plan-switch-canvas"));
      expect(pane()).toBeNull();
    } finally {
      Object.defineProperty(window, "localStorage", { configurable: true, value: real });
    }
  });

  it("another conversation's storyboard and idle move nothing: no plan comes back beside a new chat (Lens H1)", async () => {
    render(ui(null));
    await activity(A, "planning");
    await activity(A, "end");
    expect(pane()).toBeNull();
    expect(reads).toBe(0);
    await activity(null, "thinking");
    expect(pane()).toBeTruthy();
    await activity(A, "planning");
    await activity(A, "end");
    await flush();
    expect(reads).toBe(0);
    expect(screen.getByTestId("plan-thinking")).toBeTruthy();
  });

  it("on B, A's storyboard does not switch the column to A", async () => {
    byUrl = (u) => ({ status: 200, body: { brief: u.includes(B) ? withScenes(1) : withScenes(4) } });
    search = new URLSearchParams(`brain=${B}`);
    render(ui(B));
    await flush();
    await activity(A, "planning");
    await activity(A, "end");
    await flush();
    expect(readUrls.every((u) => u.endsWith(B))).toBe(true);
    expect(screen.queryByTestId("plan-storyboard")).toBeNull();
  });
});

describe("Plan column: the plan", () => {
  it("a scene card carries its title, the first line of its visual, its planned length and its cast; no per-card status word", async () => {
    await openOn(A, withScenes(2));
    const s1 = card("scene#1").closest("article") as HTMLElement;
    expect(s1.textContent).toContain("Shot 1");
    expect(s1.textContent).toContain("The kite, shot 1");
    expect(s1.textContent).not.toContain("more");
    expect(s1.textContent).toContain("planned 3 s");
    expect(s1.textContent).toContain("Aziza");
    expect(s1.textContent).not.toContain(c.status.draft);
    expect(screen.getByText(c.plan.absent.voiceMusic)).toBeTruthy();
  });

  it("while the storyboard is written: its own row, the time measured here, no per-scene count", async () => {
    await openOn(A, drafting);
    await activity(A, "planning");
    const s = screen.getByTestId("plan-storyboard");
    expect(s.textContent).toContain(c.plan.storyboard);
    expect(s.textContent).toContain(c.plan.storyboardNote);
    expect(s.textContent).not.toMatch(/\d+\s*(\/|of|%)/);
    expect(card("idea")).toBeTruthy();
    await activity(A, "end");
    expect(screen.queryByTestId("plan-storyboard")).toBeNull();
  });

  it("new cards enter in scene order, not on the first reading, and the marks go once the entrance is over", async () => {
    await openOn(A, drafting, withScenes(2));
    expect(arriving()).toEqual([]);
    await briefDone(A);
    await flush();
    // In reading order: the cast card above the scenes, then scene by scene.
    expect(arriving()).toEqual(["ref:c1", "scene#1", "scene#2"]);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 800));
    });
    expect(arriving()).toEqual([]);
  });

  it("reduced motion: the same new cards arrive with no animation", async () => {
    reduce = true;
    await openOn(A, drafting, withScenes(2));
    await briefDone(A);
    await flush();
    expect(card("scene#2")).toBeTruthy();
    expect(arriving()).toEqual([]);
  });

  it("opening another existing conversation is a first reading: nothing is called new (Lens L1)", async () => {
    byUrl = (u) => ({ status: 200, body: { brief: u.includes(A) ? withScenes(1) : withScenes(4) } });
    search = new URLSearchParams(`brain=${A}`);
    const { rerender } = render(ui(A));
    await flush();
    search = new URLSearchParams(`brain=${B}`);
    rerender(ui(A));
    await flush();
    await flush();
    expect(card("scene#4")).toBeTruthy();
    expect(arriving()).toEqual([]);
  });

  it("a failed read keeps the last board and marks it as the last one read", async () => {
    await openOn(A, withScenes(1));
    answers.push({ status: 500, body: {} });
    expect(screen.queryByTestId("plan-stale")).toBeNull();
    await briefDone(A);
    await flush();
    expect(reads).toBe(2);
    expect(card("scene#1")).toBeTruthy();
    expect(screen.getByTestId("plan-stale").textContent).toBe(c.plan.stale);
  });

  it("a turn that got no answer, with no plan yet, says so, not 'not found' (Pixel M3)", async () => {
    answers.push({ status: 404, body: {} });
    search = new URLSearchParams(`brain=${A}`);
    render(ui(A));
    await flush();
    await activity(A, "thinking");
    await activity(A, "end");
    expect(screen.getByTestId("plan-no-answer").textContent).toBe(c.plan.noAnswer);
  });

  it("a FIRST send that made no session ends as failed: the planning skeleton goes, the no-answer line shows (Atlas)", async () => {
    render(ui(null));
    await flush();
    await act(async () => void dispatchBrainCanvas({ kind: "activity", detail: { session_id: null, phase: "thinking" } }));
    expect(screen.queryAllByTestId("plan-thinking").length).toBeGreaterThan(0);
    await act(async () => void dispatchBrainCanvas({ kind: "activity", detail: { session_id: null, phase: "end", reason: "failed" } }));
    expect(screen.queryAllByTestId("plan-thinking")).toHaveLength(0);
    expect(screen.getByTestId("plan-no-answer").textContent).toBe(c.plan.noAnswer);
  });

  it("a storyboard with the server's counts says which chapter; without them, only that it is being written", async () => {
    await openOn(A, drafting);
    await activity(A, "planning");
    expect(screen.getByTestId("plan-storyboard").textContent).toContain(c.plan.storyboard);
    await activity(A, "planning", { windows: 1, of: 2, chapters_written: 2, chapters: 6 });
    expect(screen.getByTestId("plan-storyboard").textContent).toContain("Writing chapter 3 of 6");
    await activity(A, "saving");
    expect(screen.queryByTestId("plan-storyboard")).toBeNull();
    expect(screen.getByTestId("plan-busy").textContent).toBe(c.plan.saving);
    await activity(A, "pricing");
    expect(screen.getByTestId("plan-busy").textContent).toBe(c.plan.pricing);
    await activity(A, "end");
    expect(screen.queryByTestId("plan-busy")).toBeNull();
  });
});

describe("Plan column: details and Escape", () => {
  it("a card opens its step; Escape closes it, is taken (preventDefault), and focus goes back to the card", async () => {
    await openOn(A, withScenes(1));
    fireEvent.click(card("scene#1"));
    expect(screen.getByTestId("live-details")).toBeTruthy();
    expect(screen.getByTestId("live-credits").textContent).toBe(c.plan.pricedAtCreate);
    expect(screen.getByTestId("live-cast").textContent).toContain("Aziza");
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => void document.body.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(true);
    expect(screen.queryByTestId("live-details")).toBeNull();
    expect(document.activeElement).toBe(card("scene#1"));
  });
});

describe("Plan column: states", () => {
  it("a signed-out read says so, with the way back", async () => {
    await openOn(A);
    answers.length = 0;
    cleanup();
    answers.push({ status: 401, body: {} });
    render(ui(A));
    await flush();
    expect(screen.getByTestId("plan-expired").textContent).toContain(c.signIn);
  });

  it("not found and unavailable leave a way on: a new conversation, the person's canvas (Pixel M7)", async () => {
    answers.push({ status: 404, body: {} });
    search = new URLSearchParams(`brain=${A}`);
    render(ui(A));
    await flush();
    expect(screen.getByTestId("plan-new-conversation").getAttribute("href")).toBe("/alpha/studio?ai=new");
    fireEvent.click(screen.getByTestId("plan-show-canvas"));
    expect(pane()).toBeNull();
  });

  it("no conversation yet: the plan view says how it starts; a malformed activity changes nothing", async () => {
    render(ui(null));
    fireEvent.click(screen.getByTestId("plan-switch-plan"));
    expect(screen.getByTestId("plan-empty").textContent).toBe(c.plan.empty);
    fireEvent.click(screen.getByTestId("plan-switch-canvas"));
    await act(async () => void window.dispatchEvent(new CustomEvent("nightshift:brain-activity", { detail: { session_id: "x", phase: "thinking" } })));
    expect(pane()).toBeNull();
    expect(reads).toBe(0);
  });

  it("the canvas is told it is not active while the plan is shown", async () => {
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useContext(CanvasActiveContext));
      return null;
    }
    render(<PlanColumn initialSession={null}><Probe /></PlanColumn>);
    await activity(null, "thinking");
    expect(seen.at(-1)).toBe(false);
    fireEvent.click(screen.getByTestId("plan-switch-canvas"));
    expect(seen.at(-1)).toBe(true);
  });
});

describe("LiveView after a handoff (React H1, Lens M1)", () => {
  const FILMID = "0f000000-0000-4000-8000-00000000000f";
  it("settles: no commits a second once the film is read, and nothing rings on the first reading of the film", async () => {
    const { filmJson, sceneJson, S1 } = await import("./films-fixtures");
    byUrl = (url) =>
      url.includes("/api/brain/session/")
        ? { status: 200, body: { brief: { status: "created", kind: "short", title: "x", idea: "x", scenes: [{ id: "s1", n: 1, visual_prompt: "A dune" }], handoff: { kind: "film", film_id: FILMID } } } }
        : url.includes("/live")
          ? { status: 200, body: { film: filmJson({ status: "ready" }, [sceneJson(S1, 0, {})]), segments: [], takes: [] } }
          : { status: 200, body: { urls: {}, served: false } };
    let commits = 0;
    render(
      <Profiler id="lv" onRender={() => void (commits += 1)}>
        <LiveView filmStudio target={null} brain={A} />
      </Profiler>,
    );
    await waitFor(() => expect(screen.getByTestId("live-node-scene#1:clip").getAttribute("data-status")).not.toBe("draft"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    const settled = commits;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1000));
    });
    expect(commits - settled).toBeLessThanOrEqual(2);
    expect(document.querySelectorAll("[data-lit]").length).toBe(0);
  });
});

describe("below 1024 px: Chat and Plan are tabs (StudioSplit, Pixel H4)", () => {
  it("the first send of a conversation opens the plan; a later send leaves the person in the chat, with a chip to the plan", async () => {
    const { StudioSplit } = await import("../components/studio-live/StudioSplit");
    render(<StudioSplit chat={<textarea data-testid="box" defaultValue="half typed" />} column={<p data-testid="col">plan</p>} />);
    const chatTab = screen.getByTestId("studio-tab-chat");
    expect(chatTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("studio-split").dataset.tab).toBe("chat");
    await activity(null, "thinking");
    expect(screen.getByTestId("studio-split").dataset.tab).toBe("plan");
    fireEvent.click(chatTab);
    await activity(A, "thinking");
    expect(screen.getByTestId("studio-split").dataset.tab).toBe("chat");
    // Both kept mounted: the half-typed words are still there.
    expect((screen.getByTestId("box") as HTMLTextAreaElement).value).toBe("half typed");
    const chip = screen.getByTestId("studio-plan-chip");
    expect(chip.textContent).toBe(c.plan.chip.planning);
    fireEvent.click(chip);
    expect(screen.getByTestId("studio-split").dataset.tab).toBe("plan");
  });
});

describe("below 1024 px: one three-way tablist, New chat, unread, an answer waiting in the chat", () => {
  const splitUi = async (initial: string | null = null) => {
    const { StudioSplit } = await import("../components/studio-live/StudioSplit");
    const tree = () => (
      <StudioSplit initialSession={initial} chat={<p data-testid="chat">chat</p>} column={<PlanColumn initialSession={initial}><FakeCanvas /></PlanColumn>} />
    );
    const r = render(tree());
    return { ...r, again: () => r.rerender(tree()) };
  };
  const tab = () => screen.getByTestId("studio-split").dataset.tab;

  it("Chat · Plan · My canvas: the column's own switch is not drawn, and the third tab shows the person's canvas (Pixel c)", async () => {
    await splitUi();
    expect(screen.queryByTestId("plan-switch-plan")).toBeNull();
    fireEvent.click(screen.getByTestId("studio-tab-canvas"));
    expect(tab()).toBe("canvas");
    expect(canvasPane().hasAttribute("inert")).toBe(false);
    fireEvent.keyDown(screen.getByTestId("studio-tab-canvas"), { key: "ArrowLeft" });
    expect(tab()).toBe("plan");
    expect(pane()).toBeTruthy();
    expect(canvasPane().hasAttribute("inert")).toBe(true);
  });

  it("New chat (?brain= taken off) clears the chip; another conversation's storyboard and end move nothing (Lens M1, L2)", async () => {
    search = new URLSearchParams(`brain=${A}`);
    answers.push({ status: 200, body: { brief: drafting } });
    const { again } = await splitUi(A);
    await flush();
    fireEvent.click(screen.getByTestId("studio-tab-chat"));
    expect(screen.getByTestId("studio-plan-chip").textContent).toBe(c.plan.chip.open);
    await activity(A, "planning");
    expect(screen.getByTestId("studio-plan-chip").textContent).toBe(c.plan.chip.storyboard);
    await activity(B, "planning");
    await activity(B, "end");
    expect(screen.getByTestId("studio-plan-chip").textContent).toBe(c.plan.chip.storyboard);
    // New chat: the panel ends A's activity and takes ?brain= off the page.
    await activity(A, "end");
    search = new URLSearchParams();
    again();
    await flush();
    expect(screen.queryByTestId("studio-plan-chip")).toBeNull();
  });

  it("an answer that lands while the person is on the plan marks the Chat tab, and opening the chat clears it", async () => {
    await splitUi();
    await activity(null, "thinking");
    expect(tab()).toBe("plan");
    answers.push({ status: 200, body: { brief: drafting } });
    await briefDone(A);
    await flush();
    const chatTab = screen.getByTestId("studio-tab-chat");
    expect(chatTab.querySelector(".seg-dot")).not.toBeNull();
    expect(chatTab.textContent).toContain(c.plan.views.unread);
    // The outline waits for the person's choice in the chat: the plan says so, with the way there (Pixel N4).
    fireEvent.click(within(screen.getByTestId("plan-answered")).getByRole("button", { name: c.plan.openChat }));
    expect(tab()).toBe("chat");
    expect(screen.getByTestId("studio-tab-chat").querySelector(".seg-dot")).toBeNull();
  });
});

describe("replay (Lens H2)", () => {
  it("a fresh column never adopts a conversation from a send left behind by an earlier mount", async () => {
    await activity(A, "thinking");
    cleanup();
    render(ui(null));
    await flush();
    expect(readUrls).toEqual([]);
    expect(pane()).toBeNull();
    expect(window.localStorage.getItem(VIEW_MEMORY_KEY) ?? "").not.toContain(A);
  });
  it("a fresh column shows no planning skeleton for a first send that is not in flight", async () => {
    await activity(null, "thinking");
    cleanup();
    render(ui(null));
    fireEvent.click(screen.getByTestId("plan-switch-plan"));
    expect(screen.queryByTestId("plan-thinking")).toBeNull();
  });
  it("a refresh mid-storyboard: the column that mounts after the panel spoke still shows the storyboard row, and switches nothing", async () => {
    answers.push({ status: 200, body: { brief: drafting } });
    await activity(A, "planning");
    search = new URLSearchParams(`brain=${A}`);
    window.localStorage.setItem(VIEW_MEMORY_KEY, JSON.stringify({ session: A, view: "canvas" }));
    render(ui(A));
    await flush();
    expect(pane()).toBeNull();
    fireEvent.click(screen.getByTestId("plan-switch-plan"));
    expect(screen.getByTestId("plan-storyboard")).toBeTruthy();
    expect(screen.getByTestId("plan-announce").textContent).not.toContain(c.plan.autoShown);
  });
});
