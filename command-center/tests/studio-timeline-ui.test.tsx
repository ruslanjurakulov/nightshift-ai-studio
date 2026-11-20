// @vitest-environment jsdom
/**
 * Nightshift Studio's Timeline on screen (components/studio-timeline). What would break without these: sample data shown while
 * projects are switched off or their migration is missing; a scene that was never shot drawn as a picture; effects or ambience lanes
 * filled with fake clips; a number on the Assemble key before the server quoted one; a double press that starts (and holds) twice;
 * "not enough credits" without the way to add them; and Space playing the film while a person types in the Library search.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
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
const { useMediaUrls, MEDIA_RETRY_WINDOW_MS } = await import("../components/studio-timeline/useTimelineData");

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
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
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

  it("after a refusal the next press asks for a new price, never the old quote again (BR-790-02)", async () => {
    let quotes = 0;
    answer = (url) => {
      if (url.endsWith("/quote")) {
        quotes += 1;
        return { status: 200, body: { quote: priced } };
      }
      if (url.endsWith("/start")) return { status: 200, body: { start: { ok: false, reason: "reference_missing" } } };
      return { status: 200, body: { film: film() } };
    };
    await open();
    const key = () => screen.getAllByTestId("assemble-key")[0];
    fireEvent.click(key());
    await waitFor(() => expect(screen.getAllByTestId("assemble-amount")[0].textContent).toBe("16 credits"));
    fireEvent.click(key());
    fireEvent.click(await screen.findByTestId("assemble-confirm-key"));
    await waitFor(() => expect(screen.getAllByTestId("assemble-note")[0].textContent).toBe(c.startFailed.reference_missing));
    expect(screen.getAllByTestId("assemble-amount")[0].textContent).not.toMatch(/\d/);
    const startsBefore = calls.filter((x) => x.url.endsWith("/start")).length;
    fireEvent.click(key());
    await waitFor(() => expect(quotes).toBe(2));
    expect(calls.filter((x) => x.url.endsWith("/start")).length).toBe(startsBefore);
  });

  it("a server refusal of the start (an error status) also drops the quote; a network failure keeps it and its key", async () => {
    let mode: "network" | "refuse" = "network";
    answer = (url) => {
      if (url.endsWith("/quote")) return { status: 200, body: { quote: priced } };
      if (url.endsWith("/start")) {
        if (mode === "network") throw new TypeError("fetch failed");
        return { status: 400, body: { error: "invalid_params" } };
      }
      return { status: 200, body: { film: film() } };
    };
    await open();
    const key = () => screen.getAllByTestId("assemble-key")[0];
    fireEvent.click(key());
    await waitFor(() => expect(screen.getAllByTestId("assemble-amount")[0].textContent).toBe("16 credits"));
    fireEvent.click(key());
    fireEvent.click(await screen.findByTestId("assemble-confirm-key"));
    await waitFor(() => expect(screen.getAllByTestId("assemble-note")[0].textContent).toBe(c.startNoAnswer));
    mode = "refuse";
    // Retrying a start that may have gone through still goes through the confirmation (only the dialog starts anything).
    fireEvent.click(key());
    expect(calls.filter((x) => x.url.endsWith("/start"))).toHaveLength(1);
    fireEvent.click(await screen.findByTestId("assemble-confirm-key"));
    await waitFor(() => expect(calls.filter((x) => x.url.endsWith("/start"))).toHaveLength(2));
    const starts = calls.filter((x) => x.url.endsWith("/start"));
    expect(starts[1].body?.idem).toBe(starts[0].body?.idem);
    await waitFor(() => expect(screen.getAllByTestId("assemble-note")[0].textContent).toBe(c.startFailed.other));
    const quotesBefore = calls.filter((x) => x.url.endsWith("/quote")).length;
    fireEvent.click(key());
    await waitFor(() => expect(calls.filter((x) => x.url.endsWith("/quote")).length).toBe(quotesBefore + 1));
    expect(calls.filter((x) => x.url.endsWith("/start"))).toHaveLength(2);
  });

  it("H2: holding Enter on the Assemble key never starts: it quotes, opens the dialog, and the key is disabled behind it", async () => {
    answer = (url) => (url.endsWith("/quote") ? { status: 200, body: { quote: priced } } : url.endsWith("/start") ? { status: 200, body: { start: { ok: true } } } : { status: 200, body: { film: film() } });
    await open();
    const key = () => screen.getAllByTestId("assemble-key")[0] as HTMLButtonElement;
    // An auto-repeating Enter is keydown(repeat) + click, again and again; a press through the background key three times.
    for (let i = 0; i < 3; i++) {
      fireEvent.keyDown(key(), { key: "Enter", repeat: i > 0 });
      fireEvent.click(key());
      await waitFor(() => expect(calls.some((x) => x.url.endsWith("/quote"))).toBe(true));
    }
    await screen.findByTestId("assemble-confirm");
    expect(key().disabled).toBe(true);
    fireEvent.click(key());
    expect(calls.filter((x) => x.url.endsWith("/start"))).toHaveLength(0);
    // Focus is inside the dialog, on Cancel; Escape closes it; nothing was started.
    expect(document.activeElement).toBe(screen.getByTestId("assemble-confirm-cancel"));
    fireEvent.keyDown(screen.getByTestId("assemble-confirm"), { key: "Enter", repeat: true });
    fireEvent.keyDown(screen.getByTestId("assemble-confirm"), { key: "Escape" });
    expect(screen.queryByTestId("assemble-confirm")).toBeNull();
    expect(calls.filter((x) => x.url.endsWith("/start"))).toHaveLength(0);
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

describe("Lens round 2", () => {
  it("H3: a finger dragging a scene scrolls, it never reorders; Move later reorders through save_film", async () => {
    answer = (url, method) => (method === "PATCH" ? { status: 200, body: { film: filmJson({ version: 4 }, [sceneJson(S2, 0), sceneJson(S1, 1)]) } } : { status: 200, body: { film: film() } });
    await open();
    const block = screen.getByTestId(`clip-v1:${S1}`);
    fireEvent.pointerDown(block, { clientX: 10, pointerId: 1, pointerType: "touch" });
    fireEvent.pointerMove(block, { clientX: 400, pointerId: 1, pointerType: "touch" });
    fireEvent.pointerUp(block, { clientX: 400, pointerId: 1, pointerType: "touch" });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.some((x) => x.method === "PATCH")).toBe(false);
    fireEvent.click(screen.getByTestId("move-later"));
    await waitFor(() => expect(calls.some((x) => x.method === "PATCH")).toBe(true));
    const ids = (calls.find((x) => x.method === "PATCH")!.body?.patch as { scenes: { id: string }[] }).scenes.map((x) => x.id);
    expect(ids).toEqual([S2, S1]);
  });

  it("M1: a read answering an older version than the one shown does not put the old order back", async () => {
    let getVersion = 3;
    answer = (url, method) => {
      if (method === "PATCH") return { status: 200, body: { film: filmJson({ version: 4 }, [sceneJson(S2, 0, { title: "Light" }), sceneJson(S1, 1, { title: "Stadium" })]) } };
      return { status: 200, body: { film: getVersion === 3 ? film() : filmJson({ version: getVersion }, [sceneJson(S2, 0), sceneJson(S1, 1)]) } };
    };
    await open();
    fireEvent.pointerDown(screen.getByTestId(`clip-v1:${S1}`), { clientX: 0, pointerId: 1 });
    fireEvent.click(screen.getByTestId("move-later"));
    await waitFor(() => expect(screen.getByTestId(`clip-v1:${S2}`).style.left).toBe("8px"));
    // A poll answering the old version 3 (it left before the save landed): hide and show the tab to read at once.
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(calls.filter((x) => x.method === "GET" && x.url.startsWith("/api/films/")).length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId(`clip-v1:${S2}`).style.left).toBe("8px");
    getVersion = 4;
  });

  it("M4: Space on a focused button presses the button; it never plays the film", async () => {
    await open();
    const sort = screen.getByRole("button", { name: new RegExp(c.sort) });
    sort.focus();
    fireEvent.keyDown(sort, { key: " ", code: "Space" });
    expect(screen.getAllByTestId("play")[0].getAttribute("aria-pressed")).toBe("false");
  });

  it("M5: a refused music level says so in its own words and the slider goes back to the saved value", async () => {
    const MUSIC = "0c000000-0000-4000-8000-0000000000d1";
    const withMusic = () => ({ ...filmJson({ music_asset_id: MUSIC, music_gain_db: -14 }, [sceneJson(S1, 0), sceneJson(S2, 1)]), music_missing: false });
    answer = (url, method) => (method === "PATCH" ? { status: 500, body: { error: "failed" } } : url.startsWith("/api/media/") ? { status: 404, body: {} } : { status: 200, body: { film: withMusic() } });
    await open();
    fireEvent.pointerDown(screen.getByTestId(`clip-a2:${MUSIC}`), { clientX: 0, pointerId: 1 });
    const slider = screen.getByTestId("music-level").querySelector("input") as HTMLInputElement;
    expect(slider.value).toBe("-14");
    fireEvent.change(slider, { target: { value: "-6" } });
    expect(slider.value).toBe("-6");
    await waitFor(() => expect(calls.some((x) => x.method === "PATCH")).toBe(true), { timeout: 2000 });
    expect(calls.filter((x) => x.method === "PATCH")).toHaveLength(1);
    await waitFor(() => expect(slider.value).toBe("-14"));
    await waitFor(() => expect(document.body.textContent).toContain(c.levelSaveFailed));
  });

  it("a project that is not there (404) says so and offers the picker, not a Retry that cannot work", async () => {
    answer = () => ({ status: 404, body: { error: "not_found" } });
    render(<StudioTimeline filmStudio filmId={FILM} />);
    const box = await screen.findByTestId("timeline-not-found");
    expect(box.textContent).toContain(c.notFound);
    expect(screen.queryByRole("button", { name: c.retry })).toBeNull();
  });

  it("M/S on tracks the preview cannot play, and lock on tracks with nothing to lock, are disabled", async () => {
    await open();
    expect((screen.getByRole("button", { name: new RegExp(`^${c.muteTrack.replace("{t}", c.track.A3)}`) }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: c.muteTrack.replace("{t}", c.track.A1) }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: c.lockTrack.replace("{t}", c.track.V1) }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: new RegExp(`^${c.lockTrack.replace("{t}", c.track.C1)}`) }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Lens round 3", () => {
  it("N1: switching ?film= while the old project's read is in flight shows the new one, and its saves target it", async () => {
    const OTHER = "0f000000-0000-4000-8000-0000000000f2";
    let releaseOld!: (a: Answer) => void;
    answer = (url, method) => {
      if (url === `/api/films/${FILM}` && method === "GET") return new Promise<Answer>((r) => (releaseOld = r));
      if (url === `/api/films/${OTHER}` && method === "GET") return { status: 200, body: { film: filmJson({ id: OTHER, version: 2, title: "Other" }, [sceneJson(S1, 0), sceneJson(S2, 1)]) } };
      if (method === "PATCH") return { status: 200, body: { film: filmJson({ id: OTHER, version: 3 }, [sceneJson(S2, 0), sceneJson(S1, 1)]) } };
      return { status: 404, body: {} };
    };
    const view = render(<StudioTimeline filmStudio filmId={FILM} />);
    await waitFor(() => expect(calls.some((x) => x.url === `/api/films/${FILM}`)).toBe(true));
    view.rerender(<StudioTimeline filmStudio filmId={OTHER} />);
    await screen.findByTestId("lanes");
    // The old project's answer, version 9, lands now: it must not replace the new project nor raise its version guard.
    await act(async () => releaseOld({ status: 200, body: { film: filmJson({ version: 9, title: "Old" }, [sceneJson(S1, 0)]) } }));
    expect(screen.getByTestId("bar").textContent).toBe("Other");
    fireEvent.pointerDown(screen.getByTestId(`clip-v1:${S1}`), { clientX: 0, pointerId: 1 });
    fireEvent.click(screen.getByTestId("move-later"));
    await waitFor(() => expect(calls.some((x) => x.method === "PATCH")).toBe(true));
    const patch = calls.find((x) => x.method === "PATCH")!;
    expect(patch.url).toBe(`/api/films/${OTHER}`);
    expect(patch.body?.version).toBe(2);
  });

  it("a level changed while a reorder is saving goes back and says why, never silently dropped", async () => {
    const MUSIC = "0c000000-0000-4000-8000-0000000000d1";
    const withMusic = () => ({ ...filmJson({ music_asset_id: MUSIC, music_gain_db: -14 }, [sceneJson(S1, 0), sceneJson(S2, 1)]), music_missing: false });
    let releaseSave!: (a: Answer) => void;
    answer = (url, method) => (method === "PATCH" ? new Promise<Answer>((r) => (releaseSave = r)) : url.startsWith("/api/media/") ? { status: 404, body: {} } : { status: 200, body: { film: withMusic() } });
    await open();
    fireEvent.pointerDown(screen.getByTestId(`clip-v1:${S1}`), { clientX: 0, pointerId: 1 });
    fireEvent.click(screen.getByTestId("move-later"));
    await waitFor(() => expect(calls.filter((x) => x.method === "PATCH")).toHaveLength(1));
    fireEvent.pointerDown(screen.getByTestId(`clip-a2:${MUSIC}`), { clientX: 0, pointerId: 1 });
    const slider = screen.getByTestId("music-level").querySelector("input") as HTMLInputElement;
    // The slider is disabled while the reorder saves: the level cannot be changed into a race.
    expect(slider.disabled).toBe(true);
    await act(async () => releaseSave({ status: 200, body: { film: withMusic() } }));
    await waitFor(() => expect(slider.disabled).toBe(false));
  });
});

describe("media links (Lens N2)", () => {
  const ID = "0c000000-0000-4000-8000-0000000000e1";
  const ok = () => ({ status: 200, body: { asset: { kind: "video", durationS: 8 }, urls: { proxy: "/api/media/file/x" }, served: true } });

  it("errors in quick succession mark the clip failed after the retries; ordinary expiries ten minutes apart never do", async () => {
    answer = () => ok();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { result } = renderHook(() => useMediaUrls([ID]));
    await waitFor(() => expect(result.current.urls.get(ID)?.play).toBe("/api/media/file/x"));
    // Three expiries, each ten minutes after the last: every one fetches fresh links, none marks the clip failed.
    for (let i = 0; i < 3; i++) {
      now += 10 * 60_000;
      act(() => result.current.refresh(ID));
      await waitFor(() => expect(calls.filter((x) => x.url === `/api/media/${ID}`)).toHaveLength(2 + i));
    }
    expect(result.current.urls.get(ID)?.failed).toBeFalsy();
    // A file that is really broken: errors within the window → two retries, then failed, and no more requests.
    const before = calls.length;
    for (let i = 0; i < 4; i++) {
      now += i === 0 ? 10 * 60_000 : 1000;
      act(() => result.current.refresh(ID));
    }
    await waitFor(() => expect(result.current.urls.get(ID)?.failed).toBe(true));
    expect(calls.length - before).toBe(2);
    expect(MEDIA_RETRY_WINDOW_MS).toBeLessThan(10 * 60_000);
  });
});

/**
 * The page in the gap between React committing it and React running its passive effects (useEffect). RTL's render and findBy usually
 * close that gap, but on a loaded CI runner the scheduler yields after the commit (its 5 ms slice is spent), the commit's
 * MutationObserver microtask resolves findBy first, and the test presses a key or clicks a page whose effects have not run (#824:
 * "Asking the server…" never came, aria-pressed stayed "false"). A person can press in that gap too. Here the gap is forced: the
 * scheduler's clock jumps 50 ms on every read until the page is on screen, so it always yields after the commit, and `then` runs in
 * the commit's own microtask, before any passive effect.
 */
async function atFirstCommit(ready: (host: HTMLElement) => Element | null, then: (el: Element) => void) {
  const { createRoot } = await import("react-dom/client");
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasAct = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  let fake = performance.now();
  const clock = vi.spyOn(performance, "now").mockImplementation(() => (fake += 50));
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  // Registered before anything can throw or hang: RTL's cleanup does not know this root, so a failure must not leave it (and its
  // window keydown listener) mounted, or the act environment off, for the tests after it.
  onTestFinished(() => {
    root.unmount();
    host.remove();
    env.IS_REACT_ACT_ENVIRONMENT = wasAct;
  });
  await new Promise<void>((resolve) => {
    const mo = new MutationObserver(() => {
      const el = ready(host);
      if (!el) return;
      mo.disconnect();
      clock.mockRestore();
      then(el);
      resolve();
    });
    mo.observe(host, { childList: true, subtree: true });
    root.render(<StudioTimeline filmStudio filmId={FILM} />);
  });
  // Let the passive effects and the updates the press queued run, as they would on the next task.
  await new Promise((r) => setTimeout(r, 30));
  return host;
}

describe("the first frame (CI flakes on #824)", () => {
  it("a press of Assemble the moment the page is on screen asks for the price, and the answer is kept", async () => {
    let release!: (a: Answer) => void;
    answer = (url) => (url.endsWith("/quote") ? new Promise<Answer>((r) => (release = r)) : { status: 200, body: { film: film() } });
    const host = await atFirstCommit(
      (h) => h.querySelector('[data-testid="assemble-key"]'),
      (key) => (key as HTMLButtonElement).click(),
    );
    const amount = () => host.querySelector('[data-testid="assemble-amount"]')?.textContent ?? "";
      // Without the fix the panel's mount effect ran after the press, counted the press's quote as one for an older version and
      // put the key back to "Get the price": the request was sent (and counted by quote_film's rate limit), its answer dropped.
    expect(amount()).toBe(c.quoting);
    expect(calls.filter((x) => x.url.endsWith("/quote"))).toHaveLength(1);
    release({ status: 200, body: { quote: priced } });
    await waitFor(() => expect(amount()).toBe("16 credits"));
  });

  it("Space the moment the page is on screen plays: the shortcut is listening before the page can be seen", async () => {
    const host = await atFirstCommit(
      (h) => h.querySelector('[data-testid="lanes"]'),
      () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true })),
    );
    const play = host.querySelector('[data-testid="play"]') as HTMLElement;
    // Without the fix the window listener was added by a passive effect that had not run yet, so the key went nowhere.
    expect(play.getAttribute("aria-pressed")).toBe("true");
  });
});
