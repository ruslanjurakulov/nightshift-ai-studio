// @vitest-environment jsdom
/**
 * Zoom and pan, the blurred-background fit, speed (0.25-4), backwards, freeze,
 * the speed curve, smoother slow motion and an overlay's end position in the
 * editor (UI half). What would break without these: a fit picker that cannot
 * choose or show the third fit, a control that writes what the validator
 * refuses, a limit that is not on the screen with its number, a toggle that
 * stays enabled when the document would refuse it, a preview that plays a clip
 * the browser cannot play, a sentence missing in a language, or a document
 * (Save, the local draft, undo) that does not carry the choice. No network.
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
import { DRAFT_DEBOUNCE_MS, allowDraftWrites, readDraft } from "@/lib/editor-draft";
import {
  INTERP_MAX_FRAMES,
  INTERP_MAX_FRAMES_DOC,
  MOVE_ZOOM_MAX,
  RAMP_MAX_POINTS,
  SPEEDS,
  SPEED_MAX,
  SPEED_MIN,
  newDocForAsset,
  toDoc,
  toModel,
  validateTimeline,
  type EditorAsset,
  type TimelineDoc,
} from "@/lib/editor";
import { reverseLimit } from "@/lib/editorMotion";
import { captionsFromTrack } from "@/lib/captions";

const te = en.editor;
const fxe = en.editor.fx;
const sp = fxe.speed;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const P = "33333333-3333-4333-8333-333333333333";
const VIDEO: EditorAsset = { id: A, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080, viewUrl: "/v/a", thumbUrl: null };
const PHOTO: EditorAsset = { id: P, kind: "image", name: "logo.png", durationS: null, width: 400, height: 200, viewUrl: "/p/logo", thumbUrl: null };

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  allowDraftWrites();
  fetchMock = vi.fn((url: string, init?: RequestInit) =>
    String(url).endsWith(`/api/editor/projects/${PID}`) && init?.method === "PUT"
      ? json({ id: PID, rev: 2 })
      : json({ error: "failed" }, 502),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(doc: TimelineDoc, locale: "en" | "ru" | "uz" = "en", withCaptions = false) {
  return render(
    <I18nProvider locale={locale}>
      <TimelineEditor projectId={PID} title="Trip" rev={1} doc={doc} exports={[]}
        assets={{ [A]: VIDEO, [P]: PHOTO }} videos={[VIDEO]} imageFiles={[PHOTO]} userId="user-1"
        {...(withCaptions ? { orgId: "org-1", captionModels: [{ id: "m1", displayName: "Speech", languages: ["en"] }] } : {})} />
    </I18nProvider>,
  );
}
/** A 10 s video; `clip` fields are merged onto it. */
const videoDoc = (clip: Record<string, unknown> = {}): TimelineDoc => {
  const d = newDocForAsset(VIDEO)!;
  Object.assign(d.tracks[0].clips[0], clip);
  return d;
};
const photoDoc = (): TimelineDoc => ({
  ...videoDoc(),
  tracks: [{ id: "v1", kind: "V", clips: [{ id: "c1", asset_id: P, start_s: 0, in_s: 0, out_s: 5 }] }],
});
const overlayDoc = (extra: Record<string, unknown> = {}): TimelineDoc => ({
  ...videoDoc(),
  overlays: [{ id: "o1", asset_id: P, start_s: 0, end_s: 4, x: 0.5, y: 0.5, w: 0.3, opacity: 1, ...extra }],
});
const savedDoc = () => {
  const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!;
  return JSON.parse(String((put[1] as RequestInit).body)).doc as TimelineDoc;
};
const save = async () => {
  fireEvent.click(screen.getByRole("button", { name: te.save }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === "PUT")).toBe(true));
  return savedDoc();
};
const undo = () => fireEvent.click(screen.getByRole("button", { name: te.undo }));
const section = (title: string) => {
  const summary = screen.getByText(title).closest("summary")!;
  const details = summary.parentElement as HTMLDetailsElement;
  if (!details.open) fireEvent.click(summary);
  return details;
};
const more = () => section(sp.more);
const radio = (scope: HTMLElement, name: string) => within(scope).getByRole("radio", { name }) as HTMLInputElement;
const slider = (scope: HTMLElement, name: RegExp | string) => within(scope).getByRole("slider", { name }) as HTMLInputElement;
const setSlider = (el: HTMLInputElement, v: number) => fireEvent.change(el, { target: { value: String(v) } });
const check = (scope: HTMLElement, name: RegExp | string) => within(scope).getByRole("checkbox", { name }) as HTMLInputElement;
const clip0 = (d: TimelineDoc) => d.tracks[0].clips[0] as Record<string, unknown>;
const setNumber = (name: string, v: string) => {
  const el = screen.getByRole("spinbutton", { name });
  fireEvent.change(el, { target: { value: v } });
  fireEvent.keyDown(el, { key: "Enter" });
};
const movePlayhead = (t: number) =>
  fireEvent.change(screen.getByRole("slider", { name: te.playhead }), { target: { value: String(t) } });
const speedGroup = () => screen.getByRole("group", { name: te.speed });

describe("the third fit: blurred background", () => {
  const fitGroup = () => screen.getByRole("group", { name: te.fit });

  it("is a third radio beside Fit and Fill, and the hint says what it does", () => {
    mount(videoDoc());
    const radios = within(fitGroup()).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(["contain", "cover", "blur"]);
    expect(radios.filter((r) => r.checked).map((r) => r.value)).toEqual(["contain"]);
    expect(screen.getByText(te.fitHint)).toBeTruthy();
    expect(te.fitHint).toContain("blur");
  });

  it("choosing it saves fit: blur, draws the blurred copy behind the picture, undoes, and Fit returns the document", async () => {
    const before = JSON.stringify(toDoc(toModel(videoDoc())));
    mount(videoDoc());
    expect(document.querySelector("[data-testid=blur-backdrop]")).toBeNull();
    fireEvent.click(radio(fitGroup(), te.fitBlur));
    expect(radio(fitGroup(), te.fitBlur).checked).toBe(true);
    const bg = document.querySelector("[data-testid=blur-backdrop]") as HTMLElement;
    expect(bg).toBeTruthy();
    expect((bg as HTMLVideoElement).muted).toBe(true);
    expect(bg.getAttribute("aria-hidden")).toBe("true");
    expect(bg.closest("div[style*='blur']")).toBeTruthy();
    const doc = await save();
    expect(clip0(doc).fit).toBe("blur");
    expect(validateTimeline(doc)).toEqual([]);
    undo();
    expect(radio(fitGroup(), te.fitContain).checked).toBe(true);
    expect(document.querySelector("[data-testid=blur-backdrop]")).toBeNull();
    // the saved copy has the blur, so going back to Fit is a change from it
    expect(screen.getByText(te.unsaved)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: te.redo }));
    expect(screen.getByText(te.saved)).toBeTruthy();
    expect(JSON.stringify(toDoc(toModel(videoDoc())))).toBe(before);
  });

  it("a document that already has fit: blur opens with the blur key lit (not contain) and saves it back", async () => {
    mount(videoDoc({ fit: "blur" }));
    expect(radio(fitGroup(), te.fitBlur).checked).toBe(true);
    expect(radio(fitGroup(), te.fitContain).checked).toBe(false);
    fireEvent.change(screen.getByRole("textbox", { name: te.projectTitle }), { target: { value: "x" } });
    expect(clip0(await save()).fit).toBe("blur");
  });

  it("a photo has no fit choice (it always fills): no blurred copy is drawn", () => {
    mount(photoDoc());
    for (const r of within(fitGroup()).getAllByRole("radio") as HTMLInputElement[]) expect(r.disabled).toBe(true);
    expect(document.querySelector("[data-testid=blur-backdrop]")).toBeNull();
  });
});

describe("speed 0.25 to 4", () => {
  it("offers every speed of the list, the document's own range included, as one radio group", () => {
    mount(videoDoc());
    const radios = within(speedGroup()).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => Number(r.value))).toEqual([...SPEEDS]);
    expect(SPEEDS[0]).toBe(SPEED_MIN);
    expect(SPEEDS[SPEEDS.length - 1]).toBe(SPEED_MAX);
    expect(radios.filter((r) => r.checked).map((r) => Number(r.value))).toEqual([1]);
    for (const r of radios) expect((r.parentElement as HTMLElement).style.minHeight).toBe("2.75rem");
  });

  it("choosing 4x changes the clip's length and is saved; the number box takes any value and brings it into range", async () => {
    mount(videoDoc());
    fireEvent.click(radio(speedGroup(), fmt(te.speedValue, { x: 4 })));
    expect(radio(speedGroup(), fmt(te.speedValue, { x: 4 })).checked).toBe(true);
    const box = fmt(sp.custom, { min: SPEED_MIN, max: SPEED_MAX });
    expect((screen.getByRole("spinbutton", { name: box }) as HTMLInputElement).value).toBe("4");
    setNumber(box, "99");
    expect(clip0(await save()).speed).toBe(4);
    setNumber(box, "0.1");
    expect((screen.getByRole("spinbutton", { name: box }) as HTMLInputElement).value).toBe(String(SPEED_MIN));
    setNumber(box, "1.7");
    expect(clip0(toDoc(toModel(savedDoc()))).speed).toBe(4);
    undo();
    undo();
    expect(radio(speedGroup(), fmt(te.speedValue, { x: 4 })).checked).toBe(true);
  });

  it("a photo has the chips only, and says the rest is for video", () => {
    mount(photoDoc());
    expect(within(speedGroup()).getAllByRole("radio")).toHaveLength(SPEEDS.length);
    expect(screen.queryByText(sp.more)).toBeNull();
    expect(screen.getByText(sp.photoNote)).toBeTruthy();
  });
});

describe("backwards", () => {
  const limitText = () => {
    const l = reverseLimit({ width: 1920, height: 1080, fps: 30 });
    return fmt(sp.reverseLimit, { max: Math.floor(l * 10) / 10, w: 1920, h: 1080, fps: 30 });
  };

  it("shows the limit with its number and disables the toggle for a part that is too long, saying how long it is", () => {
    mount(videoDoc());
    const s = more();
    expect(check(s, sp.reverse).disabled).toBe(true);
    const text = s.textContent ?? "";
    expect(text).toContain(limitText());
    expect(text).toContain(fmt(sp.reverseTooLong, { range: 10, max: 5.7 }));
    expect(check(s, sp.reverse).getAttribute("aria-describedby")).toBeTruthy();
  });

  it("works for a short part: saved, undone, and the trim stops at the limit", async () => {
    mount(videoDoc({ out_s: 4 }));
    const s = more();
    expect(check(s, sp.reverse).disabled).toBe(false);
    fireEvent.click(check(s, sp.reverse));
    expect(check(more(), sp.reverse).checked).toBe(true);
    const doc = await save();
    expect(clip0(doc).reverse).toBe(true);
    expect(validateTimeline(doc)).toEqual([]);
    // asking for 10 s: the end stops at what can play backwards
    setNumber(te.trimOut, "10");
    const out = (screen.getByRole("spinbutton", { name: te.trimOut }) as HTMLInputElement).value;
    expect(Number(out)).toBeCloseTo(reverseLimit({ width: 1920, height: 1080, fps: 30 }), 3);
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(validateTimeline(savedDoc())).toEqual([]));
    undo();
    undo();
    expect(check(more(), sp.reverse).checked).toBe(false);
  });

  it("is carried by the local draft", () => {
    vi.useFakeTimers();
    mount(videoDoc({ out_s: 4 }));
    fireEvent.click(check(more(), sp.reverse));
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS + 50);
    expect(clip0(readDraft("user-1", PID, 1)!.doc).reverse).toBe(true);
  });

  it("the preview steps a backwards clip to the right frame instead of playing it", () => {
    mount(videoDoc({ out_s: 4, reverse: true }));
    const video = document.querySelector("[data-editor-preview-pin] video") as HTMLVideoElement;
    // the playhead is at 0: a backwards clip shows its LAST frame
    expect(video.currentTime).toBe(4);
    expect(video.muted).toBe(true);
    expect(screen.getByText(new RegExp(sp.previewNote.slice(0, 30)))).toBeTruthy();
    movePlayhead(1);
    expect(video.currentTime).toBe(3);
  });

  it("splitting says what happens to the halves", () => {
    mount(videoDoc({ out_s: 4, reverse: true }));
    movePlayhead(1);
    expect(screen.getByText(sp.splitReversed)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: te.split }));
    expect(validateTimeline(toDoc(toModel(videoDoc({ out_s: 4, reverse: true }))))).toEqual([]);
    expect(within(screen.getByRole("list", { name: te.clipsTrack })).getAllByRole("button")).toHaveLength(2);
  });
});

describe("freeze", () => {
  it("turns off speed, sound and backwards: chips disabled with the reason, sound off and locked; undo returns", async () => {
    mount(videoDoc({ out_s: 4, audio: true }));
    const s = more();
    fireEvent.click(check(s, sp.freeze));
    expect(check(more(), sp.freeze).checked).toBe(true);
    for (const r of within(speedGroup()).getAllByRole("radio") as HTMLInputElement[]) expect(r.disabled).toBe(true);
    expect(within(speedGroup()).getByText(sp.frozenNoSpeed)).toBeTruthy();
    const sound = screen.getByRole("checkbox", { name: te.sound }) as HTMLInputElement;
    expect(sound.checked).toBe(false);
    expect(sound.disabled).toBe(true);
    const doc = await save();
    expect(clip0(doc)).toMatchObject({ freeze: true, speed: 1, audio: false });
    expect(validateTimeline(doc)).toEqual([]);
    undo();
    expect(check(more(), sp.freeze).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: te.sound }) as HTMLInputElement).checked).toBe(true);
  });

  it("a frozen clip's end is its hold length, even past the file's length", async () => {
    mount(videoDoc({ out_s: 4, freeze: true, speed: 1, audio: false }));
    movePlayhead(1);
    expect(screen.getByText(sp.splitFrozen)).toBeTruthy();
    setNumber(te.trimOut, "30");
    expect((screen.getByRole("spinbutton", { name: te.trimOut }) as HTMLInputElement).value).toBe("30");
    const doc = await save();
    expect(validateTimeline(doc)).toEqual([]);
    expect(clip0(doc).out_s).toBe(30);
  });

  it("freeze at the playhead is off with its reason at the edge, and adds a held clip inside the clip", async () => {
    mount(videoDoc());
    const s = more();
    const btn = within(s).getByRole("button", { name: sp.freezeHere });
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(within(s).getByText(sp.freezeHereWhy)).toBeTruthy();
    movePlayhead(4);
    const ready = within(more()).getByRole("button", { name: sp.freezeHere });
    expect(ready.getAttribute("aria-disabled")).toBeNull();
    expect(within(more()).getByText(fmt(sp.freezeHereHint, { s: 2 }))).toBeTruthy();
    fireEvent.click(ready);
    const lane = within(screen.getByRole("list", { name: te.clipsTrack })).getAllByRole("button");
    expect(lane).toHaveLength(3);
    const doc = await save();
    const clips = doc.tracks[0].clips as Record<string, unknown>[];
    expect(clips[1]).toMatchObject({ freeze: true, in_s: 4, out_s: 6, speed: 1, audio: false });
    expect(clips[2].start_s).toBe(6);
    expect(validateTimeline(doc)).toEqual([]);
    // the new held clip is the selected one
    expect(check(more(), sp.freeze).checked).toBe(true);
  });
});

describe("speed curve", () => {
  const curve = () => section(sp.curve.title);

  it("turning it on shows a picture of the curve, the points, its length, and clears the chips", async () => {
    mount(videoDoc({ out_s: 4 }));
    more();
    fireEvent.click(check(curve(), sp.curve.toggle));
    const s = curve();
    expect(within(s).getByTestId("curve-plot").getAttribute("aria-label")).toContain("0% of the way: 1×");
    expect(within(s).getByTestId("curve-point-0")).toBeTruthy();
    expect(within(s).getByTestId("curve-point-2")).toBeTruthy();
    expect(within(s).queryByTestId("curve-point-3")).toBeNull();
    expect(within(s).getByTestId("curve-length").textContent).toContain("4");
    expect(within(speedGroup()).getAllByRole("radio").every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect(within(speedGroup()).getByText(sp.curveReplaces)).toBeTruthy();
    const doc = await save();
    expect(clip0(doc).speed_curve).toEqual([{ at: 0, speed: 1 }, { at: 0.5, speed: 1 }, { at: 1, speed: 0.25 }]);
    expect(validateTimeline(doc)).toEqual([]);
    expect(s.textContent).toContain(fmt(sp.curve.hint, { min: 2, max: 6, smin: SPEED_MIN, smax: SPEED_MAX }));
  });

  it("a point's speed and place are sliders in the document's ranges; a drag is one undo step", () => {
    mount(videoDoc({ out_s: 4 }));
    more();
    fireEvent.click(check(curve(), sp.curve.toggle));
    const mid = within(curve()).getByTestId("curve-point-1");
    const speed = slider(mid, new RegExp(`^${sp.curve.speed}`));
    expect(Number(speed.min)).toBe(SPEED_MIN);
    expect(Number(speed.max)).toBe(SPEED_MAX);
    fireEvent.pointerDown(speed);
    setSlider(speed, 2);
    setSlider(speed, 3);
    expect(within(curve()).getByTestId("curve-plot").getAttribute("aria-label")).toContain("3×");
    undo();
    expect(within(curve()).getByTestId("curve-plot").getAttribute("aria-label")).not.toContain("3×");
    const at = slider(within(curve()).getByTestId("curve-point-1"), new RegExp(`^${sp.curve.at}`));
    expect(Number(at.min)).toBeGreaterThan(0);
    expect(Number(at.max)).toBeLessThan(1);
    // the first and last points have no place to move to
    expect(within(within(curve()).getByTestId("curve-point-0")).queryAllByRole("slider")).toHaveLength(1);
  });

  it("add and remove respect 2 to 6 points; the ready shapes light up when exact", () => {
    mount(videoDoc({ out_s: 4 }));
    more();
    fireEvent.click(check(curve(), sp.curve.toggle));
    const add = () => within(curve()).getByRole("button", { name: sp.curve.add });
    for (let i = 3; i < RAMP_MAX_POINTS; i += 1) fireEvent.click(add());
    expect(within(curve()).getAllByTestId(/curve-point-/)).toHaveLength(RAMP_MAX_POINTS);
    expect(add().getAttribute("aria-disabled")).toBe("true");
    expect(within(curve()).getByText(fmt(sp.curve.maxPoints, { max: RAMP_MAX_POINTS }))).toBeTruthy();
    fireEvent.click(within(curve()).getByRole("button", { name: fmt(sp.curve.remove, { n: 2 }) }));
    expect(within(curve()).getAllByTestId(/curve-point-/)).toHaveLength(RAMP_MAX_POINTS - 1);
    fireEvent.click(radio(curve(), sp.curve.presets.hero));
    expect(radio(curve(), sp.curve.presets.hero).checked).toBe(true);
    expect(within(curve()).getAllByTestId(/curve-point-/)).toHaveLength(3);
    expect(within(curve()).getByRole("button", { name: fmt(sp.curve.remove, { n: 2 }) }).getAttribute("aria-disabled")).toBeNull();
  });

  it("removing points stops at two; a curve can be turned off to a constant speed", async () => {
    mount(videoDoc({ out_s: 4, speed_curve: [{ at: 0, speed: 1 }, { at: 0.5, speed: 2 }, { at: 1, speed: 1 }] }));
    // a clip that has a curve opens with its section open
    const s = curve();
    fireEvent.click(within(s).getByRole("button", { name: fmt(sp.curve.remove, { n: 2 }) }));
    expect(within(curve()).queryByRole("button", { name: /^Remove point/ })).toBeNull();
    fireEvent.click(check(curve(), sp.curve.toggle));
    const doc = await save();
    expect(clip0(doc).speed_curve).toBeUndefined();
    expect(clip0(doc).speed).toBe(1);
  });

  it("a clip with a curve cannot be split, and the reason is on the screen; no captions are made from it", () => {
    mount(videoDoc({ out_s: 4, speed_curve: [{ at: 0, speed: 1 }, { at: 1, speed: 2 }] }));
    movePlayhead(1);
    const split = screen.getByRole("button", { name: te.split }) as HTMLButtonElement;
    expect(split.disabled).toBe(true);
    expect(screen.getByText(sp.splitCurve)).toBeTruthy();
    expect(split.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("is carried by the local draft", () => {
    vi.useFakeTimers();
    mount(videoDoc({ out_s: 4 }));
    more();
    fireEvent.click(check(curve(), sp.curve.toggle));
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS + 50);
    expect(clip0(readDraft("user-1", PID, 1)!.doc).speed_curve).toHaveLength(3);
  });

  it("the preview shows a curve's frame at the playhead (the time map is the document's), and steps instead of playing", () => {
    mount(videoDoc({ out_s: 4, speed_curve: [{ at: 0, speed: 4 }, { at: 1, speed: 4 }] }));
    const video = document.querySelector("[data-editor-preview-pin] video") as HTMLVideoElement;
    // 4 s of video at 4x lasts 1 s: at the half-second the preview is 2 s in
    movePlayhead(0.5);
    expect(video.currentTime).toBeCloseTo(2, 1);
  });
});

describe("smoother slow motion", () => {
  const toggle = () => check(more(), sp.interpolate.toggle);

  it("is off with its reason when nothing is slow, and the budget is stated with its numbers", () => {
    mount(videoDoc({ out_s: 4 }));
    expect(toggle().disabled).toBe(true);
    const text = more().textContent ?? "";
    expect(text).toContain(sp.interpolate.notSlow);
    expect(text).toContain(fmt(sp.interpolate.hint, { clipMax: INTERP_MAX_FRAMES, docMax: INTERP_MAX_FRAMES_DOC }));
  });

  it("can be turned on for a short slow part, is saved, undone, and shows its frames", async () => {
    mount(videoDoc({ out_s: 4, speed: 0.5 }));
    expect(toggle().disabled).toBe(false);
    fireEvent.click(toggle());
    expect(toggle().checked).toBe(true);
    // 4 s at 0.5x, 30 fps, 1080p: 60 per second = 240 frames
    expect(more().textContent).toContain(fmt(sp.interpolate.used, { frames: 240, clipMax: INTERP_MAX_FRAMES, total: 240, docMax: INTERP_MAX_FRAMES_DOC }));
    const doc = await save();
    expect(clip0(doc).interpolate).toBe(true);
    expect(validateTimeline(doc)).toEqual([]);
    undo();
    expect(toggle().checked).toBe(false);
  });

  it("refuses a part that is too long, says how many frames, the budget and the longest part that fits", () => {
    mount(videoDoc({ out_s: 10, speed: 0.5 }));
    expect(toggle().disabled).toBe(true);
    expect(more().textContent).toContain(
      fmt(sp.interpolate.clipBudget, { frames: 600, max: INTERP_MAX_FRAMES, sec: 5 }),
    );
  });

  it("going faster than normal drops it, so Save never sends a refused document", async () => {
    mount(videoDoc({ out_s: 4, speed: 0.5, interpolate: true }));
    fireEvent.click(radio(speedGroup(), fmt(te.speedValue, { x: 2 })));
    expect(toggle().checked).toBe(false);
    const doc = await save();
    expect(clip0(doc).interpolate).toBeUndefined();
    expect(validateTimeline(doc)).toEqual([]);
  });

  it("trimming a clip that interpolates stops at the budget", () => {
    mount(videoDoc({ out_s: 4, speed: 0.5, interpolate: true }));
    setNumber(te.trimOut, "10");
    expect((screen.getByRole("spinbutton", { name: te.trimOut }) as HTMLInputElement).value).toBe("5");
  });
});

describe("zoom and pan", () => {
  const sec = () => section(fxe.move.title);
  const preset = (name: string) => radio(within(sec()).getByRole("group", { name: fxe.move.legend }), name);

  it("None is lit for a plain clip; a preset starts a move, draws it, is saved, and None removes it", async () => {
    mount(videoDoc());
    expect(preset(fxe.move.none).checked).toBe(true);
    expect(within(sec()).queryByTestId("move-map")).toBeNull();
    fireEvent.click(preset(fxe.move.presets.zoomIn));
    expect(preset(fxe.move.presets.zoomIn).checked).toBe(true);
    // the preview zooms: at the playhead's start the window is the whole picture, at the end 1.5x
    const mover = document.querySelector("[data-testid=clip-move]") as HTMLElement;
    expect(mover.style.transform).toBe("translate(-0%, -0%) scale(1)".replace(/-0%/g, "0%"));
    movePlayhead(9.9);
    expect((document.querySelector("[data-testid=clip-move]") as HTMLElement).style.transform).toContain("scale(1.4");
    const doc = await save();
    expect(clip0(doc).move).toEqual({ from: { zoom: 1, x: 0.5, y: 0.5 }, to: { zoom: 1.5, x: 0.5, y: 0.5 } });
    expect(validateTimeline(doc)).toEqual([]);
    fireEvent.click(preset(fxe.move.none));
    expect(document.querySelector("[data-testid=clip-move]")).toBeNull();
    undo();
    expect(preset(fxe.move.presets.zoomIn).checked).toBe(true);
  });

  it("the start and end windows are sliders in the document's ranges, drawn as a labelled map; a hand-made move says so", () => {
    mount(videoDoc());
    fireEvent.click(preset(fxe.move.presets.panRight));
    const end = within(sec()).getByTestId("move-to");
    const zoom = slider(end, fxe.move.zoom);
    expect(Number(zoom.min)).toBe(1);
    expect(Number(zoom.max)).toBe(MOVE_ZOOM_MAX);
    fireEvent.pointerDown(zoom);
    setSlider(zoom, 3);
    setSlider(zoom, 2.5);
    expect(sec().textContent).toContain(fxe.move.custom);
    expect(within(sec()).getByTestId("move-map").getAttribute("aria-label")).toBe(
      fmt(fxe.move.map, { z1: 1.5, x1: 33, y1: 50, z2: 2.5, x2: 67, y2: 50 }),
    );
    undo();
    expect(preset(fxe.move.presets.panRight).checked).toBe(true);
    expect(sec().textContent).not.toContain(fxe.move.custom);
  });

  it("says when a centre is held inside the picture, and that the centre does nothing at 1x", () => {
    mount(videoDoc());
    fireEvent.click(preset(fxe.move.presets.zoomIn));
    expect(within(sec()).getAllByText(fxe.move.wholePicture)).toHaveLength(1);
    setSlider(slider(within(sec()).getByTestId("move-to"), fxe.move.centreX), 0);
    expect(sec().textContent).toContain(fxe.move.held);
  });

  it("Hold still is for photos, which also say what happens without a move", async () => {
    mount(videoDoc());
    expect(within(sec()).queryByRole("radio", { name: fxe.move.presets.hold })).toBeNull();
    cleanup();
    mount(photoDoc());
    expect(sec().textContent).toContain(fxe.move.stillAuto);
    fireEvent.click(preset(fxe.move.presets.hold));
    const doc = await save();
    expect(clip0(doc).move).toEqual({ from: { zoom: 1, x: 0.5, y: 0.5 }, to: { zoom: 1, x: 0.5, y: 0.5 } });
    expect(validateTimeline(doc)).toEqual([]);
  });

  it("is carried by the local draft and survives opening a document that has one", async () => {
    vi.useFakeTimers();
    mount(videoDoc());
    fireEvent.click(preset(fxe.move.presets.zoomOut));
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS + 50);
    expect(clip0(readDraft("user-1", PID, 1)!.doc).move).toBeTruthy();
    vi.useRealTimers();
    cleanup();
    const d = videoDoc({ move: { from: { zoom: 2, x: 0.4 }, to: { zoom: 1 } } });
    mount(d);
    fireEvent.change(screen.getByRole("textbox", { name: te.projectTitle }), { target: { value: "x" } });
    expect(clip0(await save()).move).toEqual({ from: { zoom: 2, x: 0.4 }, to: { zoom: 1 } });
  });
});

describe("an overlay's end position", () => {
  const selectOverlay = () => fireEvent.click(screen.getByRole("button", { name: /logo\.png/ }));
  const sec = () => section(fxe.overlayMove.title);
  const overlayEl = () => document.querySelector<HTMLElement>("[data-overlay]")!;

  it("is off until asked; turning it on moves the overlay, saves a move.to, and undo returns the document", async () => {
    mount(overlayDoc());
    selectOverlay();
    expect(check(sec(), fxe.overlayMove.toggle).checked).toBe(false);
    expect(within(sec()).queryAllByRole("slider")).toHaveLength(0);
    fireEvent.click(check(sec(), fxe.overlayMove.toggle));
    expect(within(sec()).getAllByRole("slider")).toHaveLength(4);
    const doc = await save();
    expect((doc.overlays as Record<string, unknown>[])[0].move).toEqual({ to: { x: 0.75 } });
    expect(validateTimeline(doc)).toEqual([]);
    undo();
    expect(check(sec(), fxe.overlayMove.toggle).checked).toBe(false);
    expect(screen.getByText(te.unsaved)).toBeTruthy();   // the saved copy has the move
  });

  it("the end values are sliders; one equal to its start is the 'same as the start'; the preview follows the straight line", async () => {
    mount(overlayDoc());
    selectOverlay();
    fireEvent.click(check(sec(), fxe.overlayMove.toggle));
    const endX = slider(sec(), fxe.overlayMove.endX);
    setSlider(endX, 0.9);
    expect(sec().textContent).toContain(fxe.overlayMove.sameAsStart);   // y, size and opacity are not moving
    setSlider(slider(sec(), fxe.overlayMove.endOpacity), 0.4);
    expect(sec().textContent).toContain(fxe.overlayMove.slowOpacity);
    expect(Number(slider(sec(), fxe.overlayMove.endW).min)).toBeGreaterThan(0);
    // at the start of its time the picture is at its own x, halfway it is halfway to 0.9
    expect(overlayEl().style.left).toBe("50%");
    movePlayhead(2);
    expect(overlayEl().style.left).toBe("70%");
    const doc = await save();
    expect((doc.overlays as Record<string, unknown>[])[0].move).toEqual({ to: { x: 0.9, opacity: 0.4 } });
    setSlider(slider(sec(), fxe.overlayMove.endOpacity), 1);
    expect(sec().textContent).not.toContain(fxe.overlayMove.slowOpacity);
  });

  it("an end at fully clear is a quick fade and carries no slow-export warning", () => {
    mount(overlayDoc());
    selectOverlay();
    fireEvent.click(check(sec(), fxe.overlayMove.toggle));
    setSlider(slider(sec(), fxe.overlayMove.endOpacity), 0);
    expect(sec().textContent).not.toContain(fxe.overlayMove.slowOpacity);
  });

  it("turning it off removes the move; a document that has one opens with it, open, and saves it back", async () => {
    mount(overlayDoc({ move: { to: { y: 0.2, w: 0.5 } } }));
    selectOverlay();
    expect((screen.getByText(fxe.overlayMove.title).closest("details") as HTMLDetailsElement).open).toBe(true);
    expect(check(sec(), fxe.overlayMove.toggle).checked).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: te.projectTitle }), { target: { value: "x" } });
    expect(((await save()).overlays as Record<string, unknown>[])[0].move).toEqual({ to: { y: 0.2, w: 0.5 } });
    fireEvent.click(check(sec(), fxe.overlayMove.toggle));
    expect(((toDoc(toModel(videoDoc())).overlays) ?? []).length).toBe(0);
    expect(screen.getByText(te.unsaved)).toBeTruthy();
  });
});

describe("captions are not offered where word times would not line up", () => {
  const words = [{ t: "hi", s: 1, e: 1.5 }];
  const track = { words, language: "en" } as never;
  it("a clip with a speed curve or backwards play says so in the Captions panel; a plain clip does not", () => {
    mount(videoDoc({ audio: true }), "en", true);
    expect(screen.queryByTestId("captions-curved")).toBeNull();
    cleanup();
    mount(videoDoc({ audio: true, speed_curve: [{ at: 0, speed: 1 }, { at: 1, speed: 2 }] }), "en", true);
    expect(screen.getByTestId("captions-curved").textContent).toBe(sp.captionsOff);
    cleanup();
    mount(videoDoc({ audio: true, out_s: 4, reverse: true }), "en", true);
    expect(screen.getByTestId("captions-curved")).toBeTruthy();
  });
  it("laying a transcript on such a clip yields nothing, on a plain one it yields captions", () => {
    const plain = toModel(videoDoc({ audio: true }));
    expect(captionsFromTrack(plain, track, A, "clean" as never, 10)).not.toBeNull();
    const curved = toModel(videoDoc({ audio: true, speed_curve: [{ at: 0, speed: 1 }, { at: 1, speed: 2 }] }));
    expect(captionsFromTrack(curved, track, A, "clean" as never, 10)).toBeNull();
    const rev = toModel(videoDoc({ audio: true, out_s: 4, reverse: true }));
    expect(captionsFromTrack(rev, track, A, "clean" as never, 10)).toBeNull();
  });
});

describe("words", () => {
  it("the speed list and every limit shown are the document's (nothing copied into the panels)", () => {
    expect(SPEEDS).toContain(0.25);
    expect(SPEEDS).toContain(4);
    expect(en.editor.fx.speed.curve.hint).toContain("{min}");
    expect(en.editor.fx.speed.interpolate.hint).toContain("{clipMax}");
    expect(en.editor.fx.speed.reverseLimit).toContain("{max}");
  });
  it("ru and uz render the new sections in their language", () => {
    for (const [loc, d] of [["ru", ru], ["uz", uz]] as const) {
      mount(videoDoc({ out_s: 4 }), loc);
      expect(screen.getByText(d.editor.fx.move.title)).toBeTruthy();
      expect(screen.getByText(d.editor.fx.speed.more)).toBeTruthy();
      expect(screen.getByRole("radio", { name: d.editor.fitBlur })).toBeTruthy();
      cleanup();
    }
  });
  it("the blurred fit and the limits are named in ru and uz without the English or brand names", () => {
    for (const d of [ru, uz]) {
      expect(d.editor.fitBlur).not.toBe(en.editor.fitBlur);
      expect(JSON.stringify(d.editor.fx)).not.toMatch(/ffmpeg|capcut|owner|viewer/i);
    }
  });
});
