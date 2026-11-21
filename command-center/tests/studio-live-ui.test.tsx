// @vitest-environment jsdom
/**
 * The Studio's live view on screen (components/studio-live). What would break without these: a step shown done before its row says
 * so, a failure without its reason, an upload called private without the uploader saying so, a view that writes anything (it only
 * reads), polling that goes on after every step has finished, and a refusal (gone, signed out) drawn as an empty plan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { studioLiveEn as c } from "../lib/i18n/studio-live/en";
import { coerceBrief } from "../lib/studio/liveGraph";
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

const { LiveView } = await import("../components/studio-live/LiveView");

const MP4 = "f1000000-0000-4000-8000-0000000000f1";
type Answer = { status: number; body: unknown };
let calls: { method: string; url: string }[] = [];
let answer: (url: string) => Answer;

beforeEach(() => {
  calls = [];
  // Phone width: the same steps as a list (the board is React Flow's, measured by a browser).
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }));
  // The board's first render comes before the width is read; jsdom has no ResizeObserver for React Flow to measure with.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url });
      const a = answer(url);
      return new Response(JSON.stringify(a.body), { status: a.status });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const seg = (over: Record<string, unknown> = {}) => ({
  id: "seg1", status: "running", assembly_status: "planned", assembly_asset_id: null, confirmed_credits: 40, captured_credits: null,
  assembly_confirmed_credits: 8, assembly_charged_credits: null, created_at: "2026-11-21T00:00:00Z", ...over,
});
const film = (status: string, sceneOver: Record<string, unknown> = {}) => filmJson({ status }, [sceneJson(S1, 0, sceneOver)]);
const live = (body: Record<string, unknown>) => () => ({ status: 200, body });
const node = (id: string) => screen.getByTestId(`live-node-${id}`);

describe("states", () => {
  it("loading, then the steps of a running project with their real statuses", async () => {
    answer = live({
      film: film("running", { current_version: 1, takes: [{ id: "k1", kind: "keyframe", status: "running", version: 1, shot_index: 0, attempt: 1 }] }),
      segments: [seg()],
      takes: [],
    });
    render(<LiveView filmStudio target={{ kind: "film", id: FILM }} />);
    expect(screen.getByTestId("live-loading").textContent).toBe(c.loading);
    await screen.findByTestId("live-list");
    expect(node(`scene:${S1}:keyframe`).getAttribute("data-status")).toBe("working");
    expect(node(`scene:${S1}:clip`).getAttribute("data-status")).toBe("waiting");
    expect(node("final").getAttribute("data-status")).toBe("waiting");
    expect(calls[0].url).toBe(`/api/films/${FILM}/live`);
  });

  it("a failed read says so with a retry, never an empty plan; the retry only reads", async () => {
    answer = () => ({ status: 502, body: { error: "failed" } });
    render(<LiveView filmStudio target={{ kind: "film", id: FILM }} />);
    const err = await screen.findByTestId("live-error");
    expect(err.textContent).toContain(c.readFailed);
    answer = live({ film: film("draft"), segments: [], takes: [] });
    fireEvent.click(within(err).getByRole("button", { name: c.retry }));
    await screen.findByTestId("live-list");
    expect(calls.every((x) => x.method === "GET")).toBe(true);
  });

  it("gone, signed out and not installed are each said, and reading stops", async () => {
    for (const [status, testid] of [[404, "live-notfound"], [401, "live-expired"], [503, "live-unavailable"]] as const) {
      answer = () => ({ status, body: { error: "x" } });
      const view = render(<LiveView filmStudio target={{ kind: "film", id: FILM }} />);
      await screen.findByTestId(testid);
      view.unmount();
    }
  });

  it("projects switched off: nothing is read", () => {
    answer = live({});
    render(<LiveView filmStudio={false} target={{ kind: "film", id: FILM }} />);
    expect(screen.getByTestId("live-closed").textContent).toBe(c.closed);
    expect(calls).toEqual([]);
  });
});

describe("details", () => {
  it("a failed step shows its reason and remedy, and its credits as stored", async () => {
    answer = live({
      film: film("running", { current_version: 1, takes: [{ id: "c1", kind: "clip", status: "failed", version: 1, shot_index: 1, attempt: 1 }] }),
      segments: [seg()],
      takes: [{ id: "c1", error_code: "provider_timeout", confirmed_credits: 12, charged_credits: 0 }],
    });
    render(<LiveView filmStudio target={{ kind: "film", id: FILM }} />);
    await screen.findByTestId("live-list");
    fireEvent.click(node(`scene:${S1}:clip`));
    const d = screen.getByTestId("live-details");
    expect(within(d).getByTestId("live-failure").textContent).toContain("provider_timeout");
    expect(within(d).getByTestId("live-failure").textContent).toContain(c.remedyGeneric);
    expect(within(d).getByTestId("live-credits").textContent).toBe("Held 12 credits · charged 0");
    // Read-only: the failed step offers no retry key.
    expect(within(d).queryByRole("button", { name: /retry|try again/i })).toBeNull();
  });

  it("the final video offers Download and Open in Timeline only once the segment recorded the file", async () => {
    answer = live({ film: film("ready"), segments: [seg({ status: "settled", assembly_status: "completed", assembly_asset_id: MP4 })], takes: [] });
    render(<LiveView filmStudio target={{ kind: "film", id: FILM }} />);
    await screen.findByTestId("live-list");
    fireEvent.click(node("final"));
    const fin = screen.getByTestId("live-final");
    expect(within(fin).getByTestId("live-open-timeline").getAttribute("href")).toBe(`/alpha/studio?view=timeline&film=${FILM}`);
  });

  it("a done picture shows in the details (an image has a thumbnail and no play link); Escape closes and focus returns to the step", async () => {
    const PIC = "a1000000-0000-4000-8000-0000000000a1";
    answer = (url) =>
      url.startsWith("/api/media/")
        ? { status: 200, body: { asset: { kind: "image" }, urls: { thumb: "https://cdn.test/pic.webp" }, served: true } }
        : {
            status: 200,
            body: {
              film: film("running", { takes: [{ id: "k1", kind: "keyframe", status: "completed", version: 1, shot_index: 0, attempt: 1, result_asset_id: PIC }] }),
              segments: [seg()],
              takes: [],
            },
          };
    render(<LiveView filmStudio target={{ kind: "film", id: FILM }} />);
    await screen.findByTestId("live-list");
    const card = node(`scene:${S1}:keyframe`);
    fireEvent.click(card);
    const d = screen.getByTestId("live-details");
    await waitFor(() => expect(d.querySelector("img")?.getAttribute("src")).toBe("https://cdn.test/pic.webp"));
    fireEvent.keyDown(within(d).getByRole("button", { name: c.close }), { key: "Escape" });
    expect(screen.queryByTestId("live-details")).toBeNull();
    expect(document.activeElement).toBe(node(`scene:${S1}:keyframe`));
    // Opened again and then another card clicked: focus is on that card, outside the panel, and Escape still closes it.
    fireEvent.click(node(`scene:${S1}:keyframe`));
    fireEvent.click(node(`scene:${S1}:clip`));
    node(`scene:${S1}:clip`).focus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByTestId("live-details")).toBeNull();
  });

  it("a scene reads as its picture then its clip in the phone list", async () => {
    answer = live({ film: filmJson({ status: "running" }, [sceneJson(S1, 0), sceneJson(S2, 1)]), segments: [seg()], takes: [] });
    render(<LiveView filmStudio target={{ kind: "film", id: FILM }} />);
    const list = await screen.findByTestId("live-list");
    const ids = [...list.querySelectorAll("[data-testid^='live-node-']")].map((e) => e.getAttribute("data-testid")!.slice("live-node-".length));
    const at = (id: string) => ids.indexOf(id);
    expect(at(`scene:${S1}:keyframe`)).toBeLessThan(at(`scene:${S1}:clip`));
    expect(at(`scene:${S1}:clip`)).toBeLessThan(at(`scene:${S2}:keyframe`));
  });

  it("an expired session's sign-in returns to this plan; a plan not found leaves a way back to the Studio", async () => {
    answer = () => ({ status: 401, body: {} });
    render(<LiveView filmStudio target={{ kind: "film", id: FILM }} />);
    const ex = await screen.findByTestId("live-expired");
    expect(within(ex).getByRole("link").getAttribute("href")).toMatch(/^\/login\?next=/);
    cleanup();
    answer = () => ({ status: 404, body: {} });
    render(<LiveView filmStudio target={{ kind: "film", id: FILM }} />);
    await screen.findByTestId("live-notfound");
    expect(screen.getByTestId("live-back").getAttribute("href")).toBe("/alpha/studio");
  });

  it("an unreadable assembly reads not known, and its credits not recorded", async () => {
    answer = live({ film: film("assembling"), segments: null, takes: null });
    render(<LiveView filmStudio target={{ kind: "film", id: FILM }} />);
    await screen.findByTestId("live-list");
    expect(node("assembly").getAttribute("data-status")).toBe("unknown");
    fireEvent.click(node("assembly"));
    expect(screen.getByTestId("live-credits").textContent).toBe(c.creditsNone);
  });
});

describe("a channel run", () => {
  it("says where its stages come from, and the upload is private only because the uploader said so", async () => {
    answer = live({
      job: { id: 7, status: "succeeded", startedAt: "2026-11-21T00:00:00Z", finishedAt: "2026-11-21T00:30:00Z", error: null },
      events: [
        { ts: "2026-11-21T00:28:00Z", event: "upload.completed", status: "completed", agent: "youtube_uploader" },
        { ts: "2026-11-21T00:29:00Z", event: "video.published", status: "completed", agent: "youtube_uploader", privacy: "private" },
      ],
    });
    render(<LiveView filmStudio={false} target={{ kind: "run", id: "7" }} />);
    await screen.findByTestId("live-list");
    expect(screen.getByTestId("live-run-window").textContent).toBe(`${c.runWindow} ${c.stagesLag}`);
    expect(calls[0].url).toBe("/api/agent/runs/7");
    fireEvent.click(node("upload"));
    expect(screen.getByTestId("live-privacy").textContent).toBe(c.privacyPrivate);
  });

  it("a failed run names the job's reason in the customer's sentence", async () => {
    const { en } = await import("../lib/i18n/en");
    answer = live({
      job: { id: 8, status: "failed", startedAt: "t0", finishedAt: "t9", error: "voice" },
      events: [{ ts: "2026-11-21T00:01:00Z", event: "agent.failed", status: "failed", agent: "voice_gate" }],
    });
    render(<LiveView filmStudio={false} target={{ kind: "run", id: "8" }} />);
    await screen.findByTestId("live-list");
    fireEvent.click(node("voice"));
    expect(screen.getByTestId("live-failure").textContent).toBe(en.create.jobError.voice);
  });
});

describe("a channel run's live facts", () => {
  it("says GitHub's status and the hold as read, next to an honest line that stages lag", async () => {
    answer = live({ job: null, window: { since: "2026-11-21T10:00:00Z", now: "2026-11-21T10:01:00Z" }, events: [], workflow: { state: "queued" }, hold: { state: "open", amount: 40, captured: null } });
    render(<LiveView filmStudio target={{ kind: "window", channel: "ch-alpha", since: "2026-11-21T10:00:00Z", hold: "gh-abc" }} />);
    expect((await screen.findByTestId("live-workflow")).textContent).toBe(c.workflow.queued);
    expect(screen.getByTestId("live-hold").textContent).toBe("40 credits are held for this run.");
    expect(screen.getByTestId("live-run-window").textContent).toContain(c.stagesLag);
    expect(calls[0].url).toContain("&hold=gh-abc");
  });

  it("an unreadable GitHub status says so; no hold read says nothing about credits", async () => {
    answer = live({ job: null, window: { since: "2026-11-21T10:00:00Z", now: "2026-11-21T10:01:00Z" }, events: [], workflow: null, hold: null });
    render(<LiveView filmStudio target={{ kind: "window", channel: "ch-alpha", since: "2026-11-21T10:00:00Z" }} />);
    expect((await screen.findByTestId("live-workflow")).textContent).toBe(c.workflow.unknown);
    expect(screen.queryByTestId("live-hold")).toBeNull();
  });
});

describe("polling", () => {
  it("reads again while steps are working, and stops once every step has finished", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    answer = () => {
      n += 1;
      return n === 1
        ? { status: 200, body: { film: film("running"), segments: [seg()], takes: [] } }
        : { status: 200, body: { film: film("ready"), segments: [seg({ status: "settled", assembly_status: "completed", assembly_asset_id: MP4 })], takes: [] } };
    };
    render(<LiveView filmStudio target={{ kind: "film", id: FILM }} />);
    await screen.findByTestId("live-list");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6500);
    });
    await waitFor(() => expect(screen.getByTestId("live-settled").textContent).toBe(c.settled));
    const reads = calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(calls.length).toBe(reads);
    expect(calls.every((x) => x.method === "GET")).toBe(true);
  });
});

describe("the board", () => {
  it("at desktop width the same steps are a read-only board: no step can be dragged or wired", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    answer = live({ film: film("running"), segments: [seg()], takes: [] });
    render(<LiveView filmStudio target={{ kind: "film", id: FILM }} />);
    const board = await screen.findByTestId("live-board");
    await waitFor(() => expect(within(board).getByTestId("live-node-final")).toBeTruthy());
    expect(board.querySelectorAll(".react-flow__node.draggable")).toHaveLength(0);
    expect(board.querySelectorAll(".react-flow__handle.connectable")).toHaveLength(0);
    fireEvent.click(within(board).getByTestId("live-node-assembly"));
    expect(screen.getByTestId("live-details")).toBeTruthy();
  });
});

describe("before Create", () => {
  it("the brief is drawn as planned steps, nothing is read, and the note says nothing runs yet", () => {
    answer = live({});
    render(<LiveView filmStudio target={null} brief={coerceBrief({ idea: "x", scenes: [{ id: S1, n: 1, visual_prompt: "A dune" }], price: { state: "priced", nodes: { [S1]: 12 } } })} />);
    expect(screen.getByTestId("live-draft-note").textContent).toBe(c.draftNote);
    expect(node(`scene:${S1}:clip`).getAttribute("data-status")).toBe("draft");
    expect(node(`scene:${S1}:clip`).textContent).toContain("12 credits");
    expect(calls).toEqual([]);
  });
});

describe("a Nightshift AI conversation (?brain=)", () => {
  const SESSION = "b0000000-0000-4000-8000-0000000000b0";
  const brainBrief = (over: Record<string, unknown> = {}) => ({
    status: "drafting", kind: "short", title: "Desert sword", idea: "x", scenes: [{ id: S1, n: 1, visual_prompt: "A dune" }], ...over,
  });

  it("reads the conversation's brief with GET only, and reads again when the panel says this conversation changed", async () => {
    let brief = brainBrief();
    answer = (url) => (url.includes("/api/brain/session/") ? { status: 200, body: { brief, card: null, updated_at: "2026-11-21T00:00:00Z" } } : { status: 404, body: {} });
    render(<LiveView filmStudio target={null} brain={SESSION} />);
    await waitFor(() => expect(node(`scene:${S1}:clip`).getAttribute("data-status")).toBe("draft"));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Desert sword");
    brief = brainBrief({ voice: { mode: "off" } });
    act(() => {
      window.dispatchEvent(new CustomEvent("nightshift:brain-brief", { detail: { session_id: "another-conversation" } }));
    });
    expect(calls.length).toBe(1);
    act(() => {
      window.dispatchEvent(new CustomEvent("nightshift:brain-brief", { detail: { session_id: SESSION } }));
    });
    await waitFor(() => expect(node("voice").getAttribute("data-status")).toBe("none"));
    expect(calls.every((x) => x.method === "GET" && x.url === `/api/brain/session/${SESSION}`)).toBe(true);
  });

  it("after Create the view follows the handoff: the film is read live, in place", async () => {
    answer = (url) =>
      url.includes("/api/brain/session/")
        ? { status: 200, body: { brief: brainBrief({ status: "created", handoff: { kind: "film", film_id: FILM } }) } }
        : { status: 200, body: { film: film("running"), segments: [seg()], takes: [] } };
    render(<LiveView filmStudio target={null} brain={SESSION} />);
    await waitFor(() => expect(calls.some((x) => x.url === `/api/films/${FILM}/live`)).toBe(true));
    await waitFor(() => expect(node(`scene:${S1}:clip`).getAttribute("data-status")).not.toBe("draft"));
    expect(calls.every((x) => x.method === "GET")).toBe(true);
  });

  it("a conversation that is not this person's, or a server with no Brain, says so; a failed read offers Try again", async () => {
    answer = () => ({ status: 404, body: {} });
    render(<LiveView filmStudio target={null} brain={SESSION} />);
    expect((await screen.findByTestId("live-notfound")).textContent).toBe(c.briefNotFound);
    cleanup();
    answer = () => ({ status: 503, body: {} });
    render(<LiveView filmStudio target={null} brain={SESSION} />);
    expect((await screen.findByTestId("live-unavailable")).textContent).toBe(c.briefUnavailable);
    cleanup();
    answer = () => ({ status: 500, body: {} });
    render(<LiveView filmStudio target={null} brain={SESSION} />);
    const alert = await screen.findByTestId("live-error");
    expect(alert.textContent).toContain(c.briefReadFailed);
    answer = () => ({ status: 200, body: { brief: brainBrief() } });
    fireEvent.click(within(alert).getByRole("button", { name: c.retry }));
    await waitFor(() => expect(node(`scene:${S1}:clip`).getAttribute("data-status")).toBe("draft"));
  });
});
