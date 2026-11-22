// @vitest-environment jsdom
/**
 * The canvas's timeline lane in a browser (components/studio-canvas/CanvasLane). What would break without these: a wire drawn
 * above that never shows below, or a segment that stays after its wire is gone; a voice-over drawn on the clip track; a length
 * nobody measured drawn as if it were one (a "5 s" for a clip that has no length yet); a press on a segment that does nothing;
 * a lane that forgets it was closed, or breaks when storage is blocked; and a lane that grows a key that renders or spends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/studio",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { CanvasLane, LANE_OPEN_KEY } from "@/components/studio-canvas/CanvasLane";
import { EMPTY_STATE, connect, disconnect, newNode, type CanvasNode, type CanvasState } from "@/lib/studio/canvas";
import type { JobReading, NodeStatus } from "@/components/studio-canvas/nodeState";
import type { StudioJob } from "@/lib/creative/studio";

const l = dictionaries.en.studioCanvas.lane;
const CLIP_FILE = "0c000000-0000-4000-8000-0000000000a5";
const VOICE_FILE = "0c000000-0000-4000-8000-0000000000a4";
const JOB_CLIP = "1c000000-0000-4000-8000-0000000000c1";
const JOB_VOICE = "1c000000-0000-4000-8000-0000000000c2";
const JOB_ASKED = "1c000000-0000-4000-8000-0000000000c3";

const job = (id: string, capability: string, status: string, extra: Partial<StudioJob> = {}): JobReading => ({
  state: "ok",
  job: {
    id,
    capability,
    status,
    requested_model: "m",
    params: {},
    quoted_credits: 4,
    charged_credits: null,
    error_code: null,
    result: null,
    result_asset_ids: [],
    created_at: "2026-11-20T00:00:00Z",
    ...extra,
  },
});
const JOBS = new Map<string, JobReading>([
  [JOB_CLIP, job(JOB_CLIP, "t2v", "completed", { result_asset_ids: [CLIP_FILE], params: { duration_s: 5 } })],
  [JOB_VOICE, job(JOB_VOICE, "tts", "completed", { result_asset_ids: [VOICE_FILE] })],
  [JOB_ASKED, job(JOB_ASKED, "t2v", "running", { params: { duration_s: 5 } })],
]);
const PREVIEWS = new Map([
  [CLIP_FILE, { kind: "video", thumbUrl: "https://x.test/clip.jpg" }],
  [VOICE_FILE, { kind: "audio", thumbUrl: null }],
]);
// The clip file's length was measured (6 s, not the 5 asked for); the voice file's too.
const MEASURED = new Map<string, number | null>([
  [CLIP_FILE, 6],
  [VOICE_FILE, 31],
]);

const statusOf = (n: CanvasNode): NodeStatus => {
  if (n.kind === "prompt") return n.draft ? "words" : "empty";
  const r = n.jobId ? JOBS.get(n.jobId) : undefined;
  if (!r || r.state !== "ok") return "idle";
  return r.job.status === "completed" ? "done" : "working";
};

function Lane({ canvas, onPick = () => {}, phone = false, selected = null }: { canvas: CanvasState; onPick?: (id: string) => void; phone?: boolean; selected?: string | null }) {
  return (
    <I18nProvider locale="en">
      <CanvasLane
        canvas={canvas}
        statusOf={statusOf}
        nodeName={(n) => n.id}
        jobs={JOBS}
        previews={PREVIEWS}
        measured={MEASURED}
        selected={selected}
        onPick={onPick}
        resultPending={() => false}
        phone={phone}
      />
    </I18nProvider>
  );
}

const words = newNode("prompt", 0, 0, "words", { draft: "A fox at dawn" });
const seg = (id: string) => screen.queryByTestId(`lane-seg-${id}`);
const trackOf = (id: string) => seg(id)?.closest("ol")?.getAttribute("aria-label");

beforeEach(() => {
  window.localStorage.clear();
  window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
  globalThis.fetch = vi.fn(async () => new Response("{}", { status: 500 })) as typeof fetch;
});
afterEach(cleanup);

describe("the lane fills as cards are wired", () => {
  it("empty, it says in one line what puts something here, and draws no segment", () => {
    render(<Lane canvas={{ ...EMPTY_STATE, nodes: [words] }} />);
    expect(screen.getByTestId("lane-empty").textContent).toBe(l.empty);
    expect(document.querySelectorAll("[data-lane-seg]")).toHaveLength(0);
  });

  it("wiring a clip card adds its segment on the video track; a voice card lands on the voice track; unwiring takes it away", () => {
    const clip = newNode("video", 300, 0, "clip", { jobId: JOB_CLIP });
    const vo = newNode("voice", 300, 300, "vo", { jobId: JOB_VOICE });
    let canvas: CanvasState = { ...EMPTY_STATE, nodes: [words, clip, vo] };
    const { rerender } = render(<Lane canvas={canvas} />);
    expect(seg("clip")).toBeNull();
    // Not wired: left off, and the lane says how many were left off.
    expect(screen.getByTestId("lane-loose").textContent).toContain("2");

    canvas = connect(connect(canvas, "words", "clip", "w1"), "words", "vo", "w2");
    rerender(<Lane canvas={canvas} />);
    expect(trackOf("clip")).toBe(l.video);
    expect(trackOf("vo")).toBe(l.audio);
    expect(screen.queryByTestId("lane-loose")).toBeNull();

    rerender(<Lane canvas={disconnect(canvas, "clip")} />);
    expect(seg("clip")).toBeNull();
    expect(seg("vo")).not.toBeNull();
  });
});

describe("lengths are never invented", () => {
  it("measured beats requested; requested is marked; a card with no job has no length and says ?", () => {
    const made = newNode("video", 300, 0, "made", { jobId: JOB_CLIP });
    const asked = newNode("video", 300, 300, "asked", { jobId: JOB_ASKED });
    const plan = newNode("video", 300, 600, "plan");
    let canvas: CanvasState = { ...EMPTY_STATE, nodes: [words, made, asked, plan] };
    for (const [i, id] of ["made", "asked", "plan"].entries()) canvas = connect(canvas, "words", id, `w${i}`);
    render(<Lane canvas={canvas} />);

    expect(seg("made")!.dataset.length).toBe("measured");
    expect(within(seg("made")!).getByText("0:06")).toBeTruthy();
    expect(seg("asked")!.dataset.length).toBe("requested");
    expect(within(seg("asked")!).getByText("~0:05")).toBeTruthy();
    expect(seg("asked")!.getAttribute("aria-label")).toContain("0:05, requested");
    expect(seg("plan")!.dataset.length).toBe("unknown");
    expect(seg("plan")!.className).toContain("is-unk");
    expect(within(seg("plan")!).getByText("?")).toBeTruthy();
    expect(seg("plan")!.getAttribute("aria-label")).toContain(l.lengthUnknown);
    // Only a finished job's file is drawn solid, and only it carries a picture.
    expect(seg("made")!.className).toContain("is-made");
    expect(seg("made")!.querySelector("img")?.getAttribute("src")).toBe("https://x.test/clip.jpg");
    expect(seg("plan")!.className).toContain("is-plan");
    expect(seg("plan")!.querySelector("img")).toBeNull();
    // The total counts what is known (6 + 5 requested), marks it requested, and counts the unknown apart.
    expect(screen.getByTestId("lane-total").textContent).toContain("~00:00:11:00");
    expect(screen.getByText("+ 1 unknown")).toBeTruthy();
  });
});

describe("a segment finds its card", () => {
  it("a press hands the card's id to the canvas, and the selected card's segment is marked", () => {
    const onPick = vi.fn();
    const clip = newNode("video", 300, 0, "clip", { jobId: JOB_CLIP });
    const canvas = connect({ ...EMPTY_STATE, nodes: [words, clip] }, "words", "clip", "w");
    render(<Lane canvas={canvas} onPick={onPick} selected="clip" />);
    fireEvent.click(seg("clip")!);
    expect(onPick).toHaveBeenCalledWith("clip");
    expect(seg("clip")!.getAttribute("aria-current")).toBe("true");
  });
});

describe("open or closed, remembered per browser", () => {
  it("closing hides the tracks and is remembered; the phone starts closed", () => {
    const { unmount } = render(<Lane canvas={{ ...EMPTY_STATE, nodes: [words] }} />);
    const toggle = screen.getByTestId("lane-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByTestId("lane-empty")).toBeNull();
    expect(window.localStorage.getItem(LANE_OPEN_KEY)).toBe("closed");
    unmount();
    render(<Lane canvas={{ ...EMPTY_STATE, nodes: [words] }} />);
    expect(screen.getByTestId("lane-toggle").getAttribute("aria-expanded")).toBe("false");
    cleanup();
    window.localStorage.clear();
    render(<Lane canvas={{ ...EMPTY_STATE, nodes: [words] }} phone />);
    expect(screen.getByTestId("lane-toggle").getAttribute("aria-expanded")).toBe("false");
  });

  it("with storage blocked the lane still opens and closes", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<Lane canvas={{ ...EMPTY_STATE, nodes: [words] }} />);
    act(() => {
      fireEvent.click(screen.getByTestId("lane-toggle"));
    });
    expect(screen.getByTestId("lane-toggle").getAttribute("aria-expanded")).toBe("false");
    get.mockRestore();
    set.mockRestore();
  });
});

describe("nothing on the lane renders or spends (CLAUDE.md rule 3)", () => {
  it("its only keys are the open/close key and the segments, and drawing it asks the server for nothing", () => {
    const clip = newNode("video", 300, 0, "clip", { jobId: JOB_CLIP });
    const canvas = connect({ ...EMPTY_STATE, nodes: [words, clip] }, "words", "clip", "w");
    render(<Lane canvas={canvas} />);
    const keys = [...screen.getByTestId("canvas-lane").querySelectorAll("button, a, [role=button]")];
    expect(keys.every((k) => k.getAttribute("data-testid") === "lane-toggle" || k.hasAttribute("data-lane-seg"))).toBe(true);
    fireEvent.click(seg("clip")!);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
