// @vitest-environment jsdom
/**
 * The Studio's Plan column beside Nightshift AI (components/studio-live/PlanColumn.tsx). Measured on main, the canvas beside the chat
 * never changed during a conversation (docs/studio/S3_LIVE_MEASURE.md). What would break without these: a message that leaves the
 * person on their canvas with the plan nowhere, a switch back that loses what was on their canvas, a storyboard wait with nothing on
 * screen, cards that move under reduced motion, and a failed re-read that blanks the plan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { studioLiveEn as c } from "../lib/i18n/studio-live/en";
import { emitBrainActivity } from "../lib/studio/brainActivity";
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

const A = "5e550000-0000-4000-8000-0000000000e1";
const drafting = { version: 1, status: "drafting", kind: "short", voice: { mode: "off" }, music: { mode: "off" } };
const withScenes = (n: number) => ({
  ...drafting,
  status: "ready",
  title: "The kite that came back",
  scenes: Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, n: i + 1, title: `Shot ${i + 1}` })),
});

let answers: { status: number; body: unknown }[] = [];
let reads = 0;
let reduce = false;

beforeEach(() => {
  search = new URLSearchParams();
  answers = [];
  reads = 0;
  reduce = false;
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
      expect(url).toBe(`/api/brain/session/${A}`);
      reads++;
      const a = answers.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(a.body), { status: a.status });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
const activity = (session_id: string | null, phase: "thinking" | "storyboard" | "idle") => act(async () => emitBrainActivity({ session_id, phase }));
// A read resolves, then the board commits its model on the next animation frame (useBoardModel batches per frame).
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => setTimeout(r, 0));
  });
const canvasPane = () => screen.getByTestId("plan-canvas-pane");

describe("Plan column", () => {
  it("sending switches the column to the plan, even with cards on the person's canvas", async () => {
    render(<PlanColumn initialSession={null}><FakeCanvas /></PlanColumn>);
    expect(screen.getByTestId("fake-nodes")).toBeTruthy();
    expect(canvasPane().hasAttribute("inert")).toBe(false);
    expect(screen.queryByTestId("plan-board-pane")).toBeNull();
    await activity(null, "thinking");
    expect(screen.getByTestId("plan-board-pane")).toBeTruthy();
    expect(screen.getByTestId("plan-planning").textContent).toBe(c.plan.planning);
    expect(canvasPane().hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("plan-switch-plan").getAttribute("aria-pressed")).toBe("true");
    // The turn's answer: the board reads the conversation once and draws its cards.
    answers.push({ status: 200, body: { brief: drafting } });
    await briefDone(A);
    await flush();
    expect(reads).toBe(1);
    expect(screen.getByTestId("live-node-idea")).toBeTruthy();
  });

  it("the switch returns to the person's canvas as it was, and the choice holds for this conversation's next message", async () => {
    answers.push({ status: 200, body: { brief: drafting } });
    search = new URLSearchParams(`brain=${A}`);
    render(<PlanColumn initialSession={A}><FakeCanvas /></PlanColumn>);
    await flush();
    // Something done on the canvas before it was hidden.
    fireEvent.click(screen.getByText("edits 0"));
    expect(screen.getByTestId("plan-board-pane")).toBeTruthy();
    fireEvent.click(screen.getByTestId("plan-switch-canvas"));
    expect(screen.queryByTestId("plan-board-pane")).toBeNull();
    expect(canvasPane().hasAttribute("inert")).toBe(false);
    expect(screen.getByText("edits 1")).toBeTruthy();
    // Another message in the same conversation: their choice stands.
    await activity(A, "thinking");
    expect(screen.queryByTestId("plan-board-pane")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(VIEW_MEMORY_KEY) ?? "null")).toEqual({ session: A, view: "canvas" });
    // A new conversation: sending shows its plan again.
    await activity(null, "thinking");
    expect(screen.getByTestId("plan-board-pane")).toBeTruthy();
    expect(screen.getByText("edits 1")).toBeTruthy();
  });

  it("while the storyboard is written: an honest state over the cards, no per-scene count", async () => {
    answers.push({ status: 200, body: { brief: drafting } });
    search = new URLSearchParams(`brain=${A}`);
    render(<PlanColumn initialSession={A}><FakeCanvas /></PlanColumn>);
    await flush();
    await activity(A, "storyboard");
    const s = screen.getByTestId("plan-storyboard");
    expect(s.textContent).toContain(c.plan.storyboard);
    expect(s.textContent).not.toMatch(/\d/);
    expect(screen.getByTestId("live-node-idea")).toBeTruthy();
    await activity(A, "idle");
    expect(screen.queryByTestId("plan-storyboard")).toBeNull();
  });

  it("new cards enter in scene order, but not on the first reading and never under reduced motion", async () => {
    answers.push({ status: 200, body: { brief: drafting } }, { status: 200, body: { brief: withScenes(2) } });
    search = new URLSearchParams(`brain=${A}`);
    render(<PlanColumn initialSession={A}><FakeCanvas /></PlanColumn>);
    await flush();
    // The first reading after open: nothing enters.
    expect(document.querySelectorAll("[data-enter]").length).toBe(0);
    await briefDone(A);
    await flush();
    const entering = [...document.querySelectorAll<HTMLElement>("[data-enter]")].map((el) => el.dataset.testid);
    expect(entering).toEqual(["live-node-scene#1:keyframe", "live-node-scene#1:clip", "live-node-scene#2:keyframe", "live-node-scene#2:clip"]);
  });

  it("reduced motion: the same new cards arrive with no animation", async () => {
    reduce = true;
    answers.push({ status: 200, body: { brief: drafting } }, { status: 200, body: { brief: withScenes(2) } });
    search = new URLSearchParams(`brain=${A}`);
    render(<PlanColumn initialSession={A}><FakeCanvas /></PlanColumn>);
    await flush();
    await briefDone(A);
    await flush();
    expect(screen.getByTestId("live-node-scene#2:clip")).toBeTruthy();
    expect(document.querySelectorAll("[data-enter]").length).toBe(0);
  });

  it("a failed read keeps the last board and marks it as the last one read", async () => {
    answers.push({ status: 200, body: { brief: withScenes(1) } }, { status: 500, body: {} });
    search = new URLSearchParams(`brain=${A}`);
    render(<PlanColumn initialSession={A}><FakeCanvas /></PlanColumn>);
    await flush();
    expect(screen.queryByTestId("plan-stale")).toBeNull();
    await briefDone(A);
    await flush();
    expect(reads).toBe(2);
    expect(screen.getByTestId("live-node-scene#1:clip")).toBeTruthy();
    expect(screen.getByTestId("plan-stale").textContent).toBe(c.plan.stale);
  });

  it("a signed-out read says so, with the way back", async () => {
    answers.push({ status: 401, body: {} });
    search = new URLSearchParams(`brain=${A}`);
    render(<PlanColumn initialSession={A}><FakeCanvas /></PlanColumn>);
    await flush();
    expect(screen.getByTestId("plan-expired").textContent).toContain(c.signIn);
  });

  it("no conversation yet: the plan view says how it starts; a malformed activity changes nothing", async () => {
    render(<PlanColumn initialSession={null}><FakeCanvas /></PlanColumn>);
    fireEvent.click(screen.getByTestId("plan-switch-plan"));
    expect(screen.getByTestId("plan-empty").textContent).toBe(c.plan.empty);
    fireEvent.click(screen.getByTestId("plan-switch-canvas"));
    await act(async () => void window.dispatchEvent(new CustomEvent("nightshift:brain-activity", { detail: { session_id: "x", phase: "thinking" } })));
    expect(screen.queryByTestId("plan-board-pane")).toBeNull();
    expect(reads).toBe(0);
  });
});
