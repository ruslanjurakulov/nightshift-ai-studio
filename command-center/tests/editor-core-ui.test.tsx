// @vitest-environment jsdom
/**
 * The editing core (UI half): the key map in the editor (I / O marks, ' ripple delete, ; lift, , insert, Q / W,
 * Up / Down, J / K / L, Ctrl + K, the tool letters), the tool picker and its roll / slip / slide handles, the J / L
 * cut buttons and the preview's guides. What would break without these: a key that fires while a person types,
 * Ctrl + K opening the command palette instead of splitting, a handle that makes one undo step per frame or a
 * document the validator refuses, a guide that reaches the saved document, or a sentence missing in a language.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chronos/editor/p",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { fmt } from "@/lib/i18n";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import { validateTimeline, type EditorAsset, type TimelineDoc } from "@/lib/editor";

const te = en.editor;
const core = te.core;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const VIDEO: EditorAsset = { id: A, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080, viewUrl: "/v/a", thumbUrl: null };

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  fetchMock = vi.fn((url: string, init?: RequestInit) =>
    String(url).endsWith(`/api/editor/projects/${PID}`) && init?.method === "PUT" ? json({ id: PID, rev: 2 }) : json({ error: "failed" }, 502),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Two clips of the 10 s video: c1 [0, 4] (0-4), c2 [4, 8] (2-6), both with their own sound. */
const twoClips = (w = 1920, h = 1080): TimelineDoc => ({
  version: 1,
  width: w,
  height: h,
  fps: 30,
  tracks: [
    {
      id: "v1",
      kind: "V",
      clips: [
        { id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 4, speed: 1, audio: true },
        { id: "c2", asset_id: A, start_s: 4, in_s: 2, out_s: 6, speed: 1, audio: true },
      ],
    },
  ],
});
function mount(doc: TimelineDoc = twoClips(), locale: "en" | "ru" | "uz" = "en") {
  return render(
    <I18nProvider locale={locale}>
      <TimelineEditor projectId={PID} title="Trip" rev={1} doc={doc} exports={[]} assets={{ [A]: VIDEO }} videos={[VIDEO]} userId="user-1" />
    </I18nProvider>,
  );
}
const key = (k: string, init: KeyboardEventInit = {}, target: Element = document.body) => fireEvent.keyDown(target, { key: k, ...init });
const playhead = () => screen.getByRole("slider", { name: te.playhead }) as HTMLInputElement;
const seek = (t: number) => fireEvent.change(playhead(), { target: { value: String(t) } });
const clipButtons = () => within(screen.getByRole("list", { name: te.clipsTrack })).getAllByRole("button");
const undo = () => fireEvent.click(screen.getByRole("button", { name: te.undo }));
const save = async () => {
  fetchMock.mockClear();
  fireEvent.click(screen.getByRole("button", { name: te.save }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === "PUT")).toBe(true));
  const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!;
  return JSON.parse(String((put[1] as RequestInit).body)).doc as TimelineDoc;
};
const vclips = (d: TimelineDoc) => d.tracks.find((t) => t.kind === "V")!.clips as Record<string, unknown>[];
const status = () => screen.getByTestId("core-status").textContent;

describe("marks and range edits from the keyboard", () => {
  it("I and O mark a range, ' takes it out in one undo step, and the saved document is valid", async () => {
    mount();
    seek(2);
    key("i");
    seek(6);
    key("o");
    expect(screen.getByTestId("marks-range").textContent).toBe(fmt(core.marks.range, { from: "0:02.0", to: "0:06.0", length: "0:04.0" }));
    expect(screen.getByTestId("mark-in")).toBeTruthy();
    expect(screen.getByTestId("mark-out")).toBeTruthy();
    key("'");
    expect(status()).toBe(fmt(core.marks.extracted.many, { n: 2 }));
    const doc = await save();
    expect(vclips(doc).map((c) => [c.start_s, c.in_s, c.out_s])).toEqual([[0, 0, 2], [2, 4, 6]]);
    expect(validateTimeline(doc)).toEqual([]);
    // the marks went with the part they marked
    expect(screen.queryByTestId("mark-in")).toBeNull();
    undo();
    expect(vclips(await save())).toHaveLength(2);
  });

  it("; lifts: black and silent for as long, nothing after it moves, and the strip names it", async () => {
    mount();
    seek(1);
    key("i");
    seek(5);
    key("o");
    key(";");
    expect(status()).toBe(core.marks.lifted);
    const doc = await save();
    const clips = vclips(doc);
    const hold = clips.find((c) => c.freeze === true)!;
    expect(hold).toMatchObject({ start_s: 1, out_s: 5, audio: false, mask: { shape: "rect", w: 1, h: 1, invert: true } });
    expect(Math.max(...clips.map((c) => Number(c.start_s)))).toBe(5);
    expect(validateTimeline(doc)).toEqual([]);
    expect(clipButtons().some((b) => (b.getAttribute("aria-label") ?? "").includes(core.marks.holdName))).toBe(true);
  });

  it("says why a range edit was not made, and does nothing without marks", async () => {
    mount();
    key("'");
    expect(status()).toBe(core.marks.problem.no_range);
    key("i"); // in at 0: the whole picture
    key("'");
    expect(status()).toBe(core.marks.problem.whole);
    expect(clipButtons()).toHaveLength(2);
  });

  it("the buttons are the same actions, and Clear marks takes them off", () => {
    mount();
    seek(3);
    fireEvent.click(screen.getByRole("button", { name: core.marks.markIn }));
    seek(7);
    fireEvent.click(screen.getByRole("button", { name: core.marks.markOut }));
    expect(screen.getByTestId("marks-range").textContent).toContain("0:03.0");
    fireEvent.click(screen.getByRole("button", { name: core.marks.clear }));
    expect(screen.getByTestId("marks-range").textContent).toBe(core.marks.none);
    expect(screen.getByRole("button", { name: core.marks.extract }).getAttribute("aria-disabled")).toBe("true");
  });

  it(", inserts the copied clip at the playhead (split, insert, ripple)", async () => {
    mount();
    key("c", { ctrlKey: true }); // the first clip is selected
    seek(6);
    key(",");
    expect(status()).toBe(core.marks.inserted);
    const doc = await save();
    expect(vclips(doc).map((c) => c.start_s)).toEqual([0, 4, 6, 10]);
    expect(validateTimeline(doc)).toEqual([]);
  });

  it(", with nothing copied says so", () => {
    mount();
    key(",");
    expect(status()).toBe(core.marks.noClipboard);
  });

  it("none of these keys acts while typing in a field", async () => {
    mount();
    const field = screen.getByRole("textbox", { name: te.projectTitle });
    field.focus();
    for (const k of ["i", "o", "'", ";", ",", "q", "w", "j", "l", "n"]) key(k, {}, field);
    expect(screen.getByTestId("marks-range").textContent).toBe(core.marks.none);
    expect(screen.getByRole("button", { name: te.play })).toBeTruthy();
    expect((screen.getByRole("radio", { name: core.tools.trim }) as HTMLInputElement).checked).toBe(true);
    expect(clipButtons()).toHaveLength(2);
    expect(screen.queryByTestId("core-status")!.textContent).toBe("");
  });
});

describe("Q / W and Up / Down", () => {
  it("W trims the clip's end to the playhead and Q its start, closing up; one undo each", async () => {
    mount();
    seek(3);
    key("w");
    let doc = await save();
    expect(vclips(doc).map((c) => [c.start_s, c.in_s, c.out_s])).toEqual([[0, 0, 3], [3, 2, 6]]);
    seek(4);
    key("q");
    doc = await save();
    expect(vclips(doc)[1]).toMatchObject({ start_s: 3, in_s: 3, out_s: 6 });
    expect(Number(playhead().value)).toBe(3);
    undo();
    undo();
    expect(vclips(await save()).map((c) => c.out_s)).toEqual([4, 6]);
  });

  it("Q on a clip's first frame says there is nothing to trim", () => {
    mount();
    seek(4);
    key("q");
    expect(status()).toBe(core.ripple.none);
  });

  it("Down and Up jump between the cuts", () => {
    mount();
    key("ArrowDown");
    expect(Number(playhead().value)).toBe(4);
    key("ArrowDown");
    expect(Number(playhead().value)).toBe(8);
    key("ArrowDown");
    expect(Number(playhead().value)).toBe(8);
    key("ArrowUp");
    expect(Number(playhead().value)).toBe(4);
  });
});

describe("J / K / L and Ctrl + K", () => {
  it("L plays, L again is 2x (said beside the transport), K stops, J at the start does nothing", () => {
    mount();
    key("j");
    expect(screen.getByRole("button", { name: te.play })).toBeTruthy();
    key("l");
    expect(screen.getByRole("button", { name: te.pause })).toBeTruthy();
    expect(screen.queryByTestId("shuttle-rate")).toBeNull();
    key("l");
    expect(screen.getByTestId("shuttle-rate").textContent).toBe(fmt(core.shuttle.forward, { x: 2 }));
    key("k");
    expect(screen.getByRole("button", { name: te.play })).toBeTruthy();
    seek(5);
    key("j");
    expect(screen.getByTestId("shuttle-rate").textContent).toBe(fmt(core.shuttle.back, { x: 1 }));
    // Space after a shuttle plays at 1x again
    key(" ");
    key(" ");
    expect(screen.queryByTestId("shuttle-rate")).toBeNull();
  });

  it("Ctrl + K splits at the playhead and the command palette's listener never sees it; in a field it is left alone", () => {
    const palette = vi.fn();
    window.addEventListener("keydown", palette);
    try {
      mount();
      seek(2);
      key("k", { ctrlKey: true });
      expect(clipButtons()).toHaveLength(3);
      expect(palette).not.toHaveBeenCalled();
      key("k", { metaKey: true });
      expect(clipButtons()).toHaveLength(3); // nothing more to split at the same place
      const field = screen.getByRole("textbox", { name: te.projectTitle });
      field.focus();
      key("k", { ctrlKey: true }, field);
      expect(palette).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", palette);
    }
  });
});

describe("the timeline's tools", () => {
  const select2 = () => fireEvent.click(clipButtons()[1]);
  it("V, N, Y and U pick the tool, and the picker says what it does", () => {
    mount();
    const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;
    expect(radio(core.tools.trim).checked).toBe(true);
    key("n");
    expect(radio(core.tools.roll).checked).toBe(true);
    expect(screen.getByTestId("tool-picker").textContent).toContain(core.tools.hint.roll);
    key("y");
    expect(radio(core.tools.slip).checked).toBe(true);
    key("u");
    expect(radio(core.tools.slide).checked).toBe(true);
    key("v");
    expect(radio(core.tools.trim).checked).toBe(true);
  });

  it("roll: the cut handle moves a frame per arrow, a run of arrows is one undo step, the length stays", async () => {
    mount();
    select2();
    fireEvent.click(screen.getByRole("radio", { name: core.tools.roll }));
    const h = screen.getByRole("slider", { name: fmt(core.tools.rollHandle, { a: 1, b: 2 }) });
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(h, { key: "ArrowRight" });
    fireEvent.keyDown(h, { key: "ArrowRight", shiftKey: true });
    const doc = await save();
    expect(vclips(doc)[0].out_s).toBe(5.1);
    expect(vclips(doc)[1]).toMatchObject({ start_s: 5.1, in_s: 3.1, out_s: 6 });
    expect(validateTimeline(doc)).toEqual([]);
    undo();
    expect(vclips(await save())[0].out_s).toBe(4);
  });

  it("slip: the clip shows a later part of its file in the same place; at the file's end it says it cannot go on", async () => {
    mount();
    select2();
    fireEvent.click(screen.getByRole("radio", { name: core.tools.slip }));
    const h = screen.getByRole("slider", { name: fmt(core.tools.slipHandle, { n: 2 }) });
    for (let i = 0; i < 5; i += 1) fireEvent.keyDown(h, { key: "ArrowRight", shiftKey: true });
    const doc = await save();
    expect(vclips(doc)[1]).toMatchObject({ start_s: 4, in_s: 6, out_s: 10 });
    expect(validateTimeline(doc)).toEqual([]);
    fireEvent.keyDown(screen.getByRole("slider", { name: fmt(core.tools.slipHandle, { n: 2 }) }), { key: "ArrowRight" });
    expect(status()).toBe(core.tools.stuck);
  });

  it("slide: the first clip has no handle (nothing before it to give), the middle one moves between its neighbours", async () => {
    const doc3 = twoClips();
    doc3.tracks[0].clips.push({ id: "c3", asset_id: A, start_s: 8, in_s: 1, out_s: 3, speed: 1, audio: true });
    mount(doc3);
    fireEvent.click(screen.getByRole("radio", { name: core.tools.slide }));
    // the first clip is selected: it has no neighbour before it, so there is no handle
    const h1 = screen.getByRole("slider", { name: fmt(core.tools.slideHandle, { n: 1 }) });
    fireEvent.keyDown(h1, { key: "ArrowRight" });
    expect(status()).toBe(core.tools.stuck);
    select2();
    const h = screen.getByRole("slider", { name: fmt(core.tools.slideHandle, { n: 2 }) });
    fireEvent.keyDown(h, { key: "ArrowLeft", shiftKey: true });
    const doc = await save();
    expect(vclips(doc).map((c) => [c.start_s, c.in_s, c.out_s])).toEqual([[0, 0, 3], [3, 2, 6], [7, 0, 3]]);
    expect(validateTimeline(doc)).toEqual([]);
  });

  it("a roll handle can be dragged: one undo step for the whole drag", async () => {
    // jsdom has no PointerEvent: without one the events carry no clientX.
    class PointerEventLike extends MouseEvent {
      pointerId: number;
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
        this.pointerType = init.pointerType ?? "mouse";
      }
    }
    vi.stubGlobal("PointerEvent", PointerEventLike);
    mount();
    select2();
    fireEvent.click(screen.getByRole("radio", { name: core.tools.roll }));
    const strip = screen.getByRole("list", { name: te.clipsTrack }).parentElement as HTMLElement;
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({ width: 800, height: 100, top: 0, left: 0, right: 800, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const h = screen.getByRole("slider", { name: fmt(core.tools.rollHandle, { a: 1, b: 2 }) });
    fireEvent.pointerDown(h, { clientX: 320, pointerId: 1 });
    fireEvent.pointerMove(h, { clientX: 360, pointerId: 1 }); // 800 px for 8 s: 40 px is 0.4 s
    fireEvent.pointerMove(h, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(h, { pointerId: 1 });
    const doc = await save();
    expect(vclips(doc)[0].out_s).toBe(4.8);
    undo();
    expect(vclips(await save())[0].out_s).toBe(4);
  });
});

describe("the J / L cut", () => {
  it("L cut on the second clip detaches both sounds and runs the first past the cut; one undo returns it", async () => {
    mount();
    fireEvent.click(clipButtons()[1]);
    const g = screen.getByTestId("split-edit");
    fireEvent.click(within(g).getByRole("button", { name: core.jl.l }));
    expect(within(g).getByText(fmt(core.jl.done.many, { n: 12 }))).toBeTruthy();
    const doc = await save();
    const a = doc.tracks.filter((t) => t.kind === "A").map((t) => t.clips[0]);
    expect(a.map((c) => [c.start_s, c.in_s, c.out_s])).toEqual([[0, 0, 4.4], [4.4, 2.4, 6]]);
    expect(vclips(doc).every((c) => c.audio === false)).toBe(true);
    expect(validateTimeline(doc)).toEqual([]);
    undo();
    expect((await save()).tracks.filter((t) => t.kind === "A")).toHaveLength(0);
  });

  it("is not offered on the first clip, and says why on a clip with no sound either side", () => {
    const d = twoClips();
    for (const c of d.tracks[0].clips) c.audio = false;
    mount(d);
    expect(screen.queryByTestId("split-edit")).toBeNull();
    fireEvent.click(clipButtons()[1]);
    fireEvent.click(within(screen.getByTestId("split-edit")).getByRole("button", { name: core.jl.j }));
    expect(screen.getByText(core.jl.problem.no_sound)).toBeTruthy();
  });
});

describe("the preview's guides", () => {
  it("title / action safe and thirds draw on the preview only, never in the saved document, and are remembered here", async () => {
    mount();
    expect(screen.queryByTestId("preview-guides")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: core.guides.safe }));
    fireEvent.click(screen.getByRole("checkbox", { name: core.guides.grid }));
    const svg = screen.getByTestId("preview-guides");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelector('[data-guide="title"]')).toBeTruthy();
    expect(svg.querySelector('[data-guide="action"]')).toBeTruthy();
    expect(svg.querySelector('[data-guide="grid"]')).toBeTruthy();
    // a 16:9 frame has no app areas: the picker is off and says why
    const app = screen.getByRole("combobox", { name: core.guides.app }) as HTMLSelectElement;
    expect(app.disabled).toBe(true);
    expect(screen.getByText(core.guides.verticalOnly)).toBeTruthy();
    // the document did not change: there is nothing to save
    expect((screen.getByRole("button", { name: te.save }) as HTMLButtonElement).disabled).toBe(true);
    // a real edit, so the document is saved and can be read
    seek(3);
    key("w");
    const doc = await save();
    expect(JSON.stringify(doc)).not.toMatch(/guide|safe/i);
    expect(JSON.parse(localStorage.getItem("ns-editor-guides")!)).toEqual({ app: null, safe: true, grid: true });
  });

  it("on a 9:16 frame each app's areas are drawn", () => {
    mount(twoClips(1080, 1920));
    const app = screen.getByRole("combobox", { name: core.guides.app }) as HTMLSelectElement;
    expect(app.disabled).toBe(false);
    for (const v of ["shorts", "tiktok", "reels"]) {
      fireEvent.change(app, { target: { value: v } });
      expect(screen.getByTestId("preview-guides").querySelectorAll('[data-guide="app"]').length).toBeGreaterThanOrEqual(4);
    }
    fireEvent.change(app, { target: { value: "" } });
    expect(screen.queryByTestId("preview-guides")).toBeNull();
  });
});

describe("the shortcuts help and the three languages", () => {
  it("lists the new keys with their labels", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: te.view.shortcuts }));
    const dlg = screen.getByRole("dialog", { name: te.view.shortcutsTitle });
    for (const label of [core.keys.shuttleBack, core.keys.markIn, core.keys.extract, core.keys.lift, core.keys.rippleHead, core.keys.edits, core.keys.toolRoll])
      expect(within(dlg).getByText(label)).toBeTruthy();
    expect(within(dlg).getAllByText("K", { selector: "kbd" })).toHaveLength(2); // K and Ctrl + K
  });

  it("every string is in all three languages, Uzbek and Russian included on screen", () => {
    const flat = (o: unknown, p = ""): [string, string][] =>
      typeof o === "string" ? [[p, o]] : Object.entries(o as object).flatMap(([k, v]) => flat(v, p ? `${p}.${k}` : k));
    const keys = (d: typeof en) => flat(d.editor.core).map(([k]) => k).sort();
    expect(keys(ru as unknown as typeof en)).toEqual(keys(en));
    expect(keys(uz as unknown as typeof en)).toEqual(keys(en));
    for (const [k, v] of [...flat(uz.editor.core), ...flat(ru.editor.core)]) expect(v.trim().length, k).toBeGreaterThan(0);
    // no superlative claims and no maker's name in the copy
    const all = [...flat(en.editor.core), ...flat(ru.editor.core), ...flat(uz.editor.core)].map(([, v]) => v).join(" ");
    expect(all).not.toMatch(/\beng (yaxshi|zoʻr|tez|arzon|kuchli)\b|premiere|adobe/i);
    cleanup();
    mount(twoClips(), "uz");
    expect(screen.getByRole("button", { name: uz.editor.core.marks.markIn })).toBeTruthy();
    expect(screen.getByRole("radio", { name: uz.editor.core.tools.roll })).toBeTruthy();
    cleanup();
    mount(twoClips(), "ru");
    expect(screen.getByRole("button", { name: ru.editor.core.marks.lift })).toBeTruthy();
  });
});
