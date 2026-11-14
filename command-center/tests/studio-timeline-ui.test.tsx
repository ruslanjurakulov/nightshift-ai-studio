// @vitest-environment jsdom
/**
 * Nightshift Studio's Timeline on screen (components/studio-timeline). What would break without these: sample data shown while
 * projects are switched off or their migration is missing; a scene that was never shot drawn as a picture; effects or ambience lanes
 * filled with fake clips; a number on the Assemble key before the server quoted one; a double press that starts (and holds) twice;
 * "not enough credits" without the way to add them; and Space playing the film while a person types in the Library search.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { studioTimelineEn as c } from "../lib/i18n/studio-timeline/en";
import { FILM, S1, S2, filmJson, sceneJson } from "./films-fixtures";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("next/link", () => ({
  default: ({ href, children, scroll: _s, ...rest }: { href: string; children: ReactNode; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/alpha${p}` }));
vi.mock("@/lib/credits-live", () => ({ refreshCredits: vi.fn(async () => undefined) }));
// The project bar is the canvas's own (tested there); here a stand-in so this file does not mount the canvas's composer.
vi.mock("@/components/studio-canvas/StudioCanvas", () => ({
  BAR_SLOT_ID: "studio-bar-slot",
  ProjectBar: ({ title }: { title?: string }) => <div data-testid="bar">{title}</div>,
}));

const { StudioTimeline } = await import("../components/studio-timeline/StudioTimeline");

type Answer = { status: number; body: unknown };
let calls: { method: string; url: string; body: Record<string, unknown> | undefined }[] = [];
let answer: (url: string, method: string, body: Record<string, unknown> | undefined) => Answer | Promise<Answer>;

const QUOTE_ID = `fq-3-${"b".repeat(32)}`;
const priced = { priced: true, total: 16, quote_id: QUOTE_ID, startable: true, may_start: true, blocked_by: [], refusals: [], assembly_minutes: 8, available: 100, exempt: false };
const film = () => filmJson({}, [sceneJson(S1, 0, { title: "Stadium", narration: "The year is 2050." }), sceneJson(S2, 1, { title: "Light" })]);

// jsdom has no PointerEvent: without one, fireEvent.pointer* carries no clientX and a drag reads as a click.
if (typeof window.PointerEvent === "undefined") {
  class PE extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  (window as unknown as { PointerEvent: typeof PE }).PointerEvent = PE;
}

beforeEach(() => {
  calls = [];
  answer = (url) => (url.startsWith("/api/films/") && !url.includes("/quote") && !url.includes("/start") ? { status: 200, body: { film: film() } } : { status: 404, body: { error: "not_found" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ method, url, body });
      const a = await answer(url, method, body);
      return new Response(JSON.stringify(a.body), { status: a.status });
    }),
  );
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const open = async () => {
  render(<StudioTimeline filmStudio filmId={FILM} />);
  await screen.findByTestId("lanes");
};

describe("honest states", () => {
  it("switched off: 'Projects are not open yet', and nothing is read", () => {
    render(<StudioTimeline filmStudio={false} filmId={FILM} />);
    expect(screen.getByTestId("timeline-closed").textContent).toContain(c.closed);
    expect(calls).toEqual([]);
    expect(screen.queryByTestId("lanes")).toBeNull();
  });

  it("migration missing (503 not_available): says the tables are not there, draws no lane", async () => {
    answer = () => ({ status: 503, body: { error: "not_available" } });
    render(<StudioTimeline filmStudio filmId={FILM} />);
    expect((await screen.findByTestId("timeline-missing")).textContent).toContain(c.missing);
    expect(screen.queryByTestId("lanes")).toBeNull();
  });

  it("a failed read says so with a retry, never an empty timeline", async () => {
    answer = () => ({ status: 502, body: { error: "failed" } });
    render(<StudioTimeline filmStudio filmId={FILM} />);
    await screen.findByTestId("timeline-error");
    answer = () => ({ status: 200, body: { film: film() } });
    fireEvent.click(screen.getByRole("button", { name: c.retry }));
    await screen.findByTestId("lanes");
  });
});

describe("the lanes", () => {
  it("a scene without a take is a dashed draft at its planned length", async () => {
    await open();
    const block = screen.getByTestId(`clip-v1:${S1}`);
    expect(block.hasAttribute("data-draft")).toBe(true);
    expect(block.textContent).toContain("0:08");
    expect(screen.getByTestId("viewer-draft")).toBeTruthy();
  });

  it("a shot scene whose preview cannot be read is never called a draft", async () => {
    const CLIP = "c1000000-0000-4000-8000-0000000000c1";
    const shot = filmJson({}, [sceneJson(S1, 0, { current_version: 1, takes: [{ id: crypto.randomUUID(), scene_id: S1, version: 1, shot_index: 1, kind: "clip", status: "completed", duration_s: 5, result_asset_id: CLIP }] })]);
    answer = (url) => (url.startsWith("/api/media/") ? { status: 404, body: { error: "not_found" } } : { status: 200, body: { film: shot } });
    await open();
    expect(screen.getByTestId(`clip-v1:${S1}`).hasAttribute("data-draft")).toBe(false);
    await waitFor(() => expect(screen.getByTestId("viewer-unavailable").textContent).toBe(c.previewFailed));
    expect(screen.queryByTestId("viewer-draft")).toBeNull();
  });

  it("A3 and A4 render empty with their reason; no clip is drawn on them", async () => {
    await open();
    for (const id of ["A3", "A4"] as const) {
      const lane = screen.getByTestId(`lane-${id}`);
      expect(lane.querySelectorAll(".tl-clip")).toHaveLength(0);
      expect(screen.getByTestId(`lane-empty-${id}`).textContent).toBe(c.laneEmpty[id]);
    }
    expect(screen.getByTestId("lane-empty-A1").textContent).toBe(c.laneEmpty.A1);
    expect(screen.getByTestId("lane-C1").querySelectorAll(".tl-clip")).toHaveLength(2);
  });

  it("meters rest at zero when nothing plays", async () => {
    await open();
    for (const k of ["V1", "A1", "A2", "A3", "A4", "main"]) {
      expect((screen.getByTestId(`meter-${k}`).querySelector("i") as HTMLElement).style.height).toBe("0%");
    }
  });
});

describe("Assemble", () => {
  it("shows no number before the backend quote, then exactly the server's", async () => {
    let release!: (a: Answer) => void;
    answer = (url) => (url.endsWith("/quote") ? new Promise<Answer>((r) => (release = r)) : { status: 200, body: { film: film() } });
    await open();
    const amount = () => screen.getAllByTestId("assemble-amount")[0].textContent ?? "";
    expect(amount()).toBe(c.getPrice);
    expect(amount()).not.toMatch(/\d/);
    fireEvent.click(screen.getAllByTestId("assemble-key")[0]);
    await waitFor(() => expect(amount()).toBe(c.quoting));
    expect(amount()).not.toMatch(/\d/);
    await act(async () => release({ status: 200, body: { quote: priced } }));
    await waitFor(() => expect(amount()).toBe("16 credits"));
    expect(calls.find((x) => x.url.endsWith("/quote"))?.body).toEqual({ version: 3 });
  });

  it("an unpriced quote keeps the key without a number and says pricing is not live", async () => {
    answer = (url) => (url.endsWith("/quote") ? { status: 200, body: { quote: { priced: false, total: null, quote_id: null, refusals: [{ reason: "unpriced" }], blocked_by: [] } } } : { status: 200, body: { film: film() } });
    await open();
    fireEvent.click(screen.getAllByTestId("assemble-key")[0]);
    await waitFor(() => expect(screen.getAllByTestId("assemble-note")[0].textContent).toContain(c.noPrice));
    expect(screen.getAllByTestId("assemble-amount")[0].textContent).not.toMatch(/\d/);
  });

  it("a failed quote read is said as one: not 'pricing is not live', and still no number", async () => {
    answer = (url) => (url.endsWith("/quote") ? { status: 502, body: { error: "failed" } } : { status: 200, body: { film: film() } });
    await open();
    fireEvent.click(screen.getAllByTestId("assemble-key")[0]);
    await waitFor(() => expect(screen.getAllByTestId("assemble-note")[0].textContent).toBe(c.quoteFailed));
    expect(screen.getAllByTestId("assemble-amount")[0].textContent).not.toMatch(/\d/);
  });

  it("quote_film missing (0171 not applied): pricing is not live, no number", async () => {
    answer = (url) => (url.endsWith("/quote") ? { status: 503, body: { error: "not_available" } } : { status: 200, body: { film: film() } });
    await open();
    fireEvent.click(screen.getAllByTestId("assemble-key")[0]);
    await waitFor(() => expect(screen.getAllByTestId("assemble-note")[0].textContent).toContain(c.noPrice));
  });

  it("a double press on confirm sends one start, with the quote and one key", async () => {
    let release!: (a: Answer) => void;
    answer = (url) => {
      if (url.endsWith("/quote")) return { status: 200, body: { quote: priced } };
      if (url.endsWith("/start")) return new Promise<Answer>((r) => (release = r));
      return { status: 200, body: { film: film() } };
    };
    await open();
    const key = () => screen.getAllByTestId("assemble-key")[0];
    fireEvent.click(key());
    await waitFor(() => expect(screen.getAllByTestId("assemble-amount")[0].textContent).toBe("16 credits"));
    fireEvent.click(key());
    const confirm = await screen.findByTestId("assemble-confirm-key");
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await act(async () => release({ status: 200, body: { start: { ok: true, replayed: false } } }));
    const starts = calls.filter((x) => x.url.endsWith("/start"));
    expect(starts).toHaveLength(1);
    expect(starts[0].body?.quote_id).toBe(QUOTE_ID);
    expect(String(starts[0].body?.idem)).toMatch(/^film-[0-9a-f]{32}$/);
    await waitFor(() => expect(screen.getAllByTestId("assemble-note")[0].textContent).toContain(c.started));
  });

  it("insufficient credits: says so and links to add credits; the key does not start", async () => {
    answer = (url) => (url.endsWith("/quote") ? { status: 200, body: { quote: { ...priced, startable: false, blocked_by: [{ reason: "insufficient_credits" }] } } } : { status: 200, body: { film: film() } });
    await open();
    fireEvent.click(screen.getAllByTestId("assemble-key")[0]);
    const link = await screen.findAllByTestId("assemble-add-credits");
    expect(link[0].getAttribute("href")).toBe("/alpha/billing");
    expect((screen.getAllByTestId("assemble-key")[0] as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((x) => x.url.endsWith("/start"))).toBe(false);
  });

  it("start refused for credits after the quote: the same link", async () => {
    answer = (url) => {
      if (url.endsWith("/quote")) return { status: 200, body: { quote: priced } };
      if (url.endsWith("/start")) return { status: 200, body: { start: { ok: false, reason: "insufficient_credits" } } };
      return { status: 200, body: { film: film() } };
    };
    await open();
    fireEvent.click(screen.getAllByTestId("assemble-key")[0]);
    await waitFor(() => expect(screen.getAllByTestId("assemble-amount")[0].textContent).toBe("16 credits"));
    fireEvent.click(screen.getAllByTestId("assemble-key")[0]);
    fireEvent.click(await screen.findByTestId("assemble-confirm-key"));
    expect((await screen.findAllByTestId("assemble-add-credits"))[0].getAttribute("href")).toBe("/alpha/billing");
  });
});

describe("keyboard", () => {
  it("Space plays on the page, but not while typing in the Library search or with focus in the inspector", async () => {
    await open();
    const play = () => screen.getAllByTestId("play")[0];
    const search = screen.getByRole("searchbox", { name: c.search });
    search.focus();
    fireEvent.keyDown(search, { key: " ", code: "Space" });
    expect(play().getAttribute("aria-pressed")).toBe("false");
    const tab = screen.getByRole("tab", { name: c.tabAudio });
    fireEvent.keyDown(tab, { key: " ", code: "Space" });
    expect(play().getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    await waitFor(() => expect(play().getAttribute("aria-pressed")).toBe("true"));
    fireEvent.keyDown(document.body, { key: "k", code: "KeyK" });
    await waitFor(() => expect(play().getAttribute("aria-pressed")).toBe("false"));
  });
});

describe("reorder", () => {
  it("dragging a scene past the next saves the whole order through save_film at the version read", async () => {
    answer = (url, method) => (method === "PATCH" ? { status: 200, body: { film: film() } } : { status: 200, body: { film: film() } });
    await open();
    const block = screen.getByTestId(`clip-v1:${S1}`);
    fireEvent.pointerDown(block, { clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(block, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(block, { clientX: 400, pointerId: 1 });
    await waitFor(() => expect(calls.some((x) => x.method === "PATCH")).toBe(true));
    const patch = calls.find((x) => x.method === "PATCH")!;
    expect(patch.body?.version).toBe(3);
    const ids = (patch.body?.patch as { scenes: { id: string }[] }).scenes.map((s) => s.id);
    expect(ids).toEqual([S2, S1]);
  });
});
