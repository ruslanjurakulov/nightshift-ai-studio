// @vitest-environment jsdom
/**
 * Effects, crop and tilt, and entrance / exit animations in the editor (UI half):
 * the Look and effects section, the Crop and tilt section and the Entrance and
 * exit pickers of a text and an overlay. What would break without these: a
 * control that does not change the document (or changes it without an undo step),
 * a value Save sends that the validator refuses, a preview that draws something
 * the document does not hold, a key under 44px, a limit not shown, a sentence
 * missing in a language, or a document (Save, the local draft) that does not carry
 * the choice. Nothing here renders, spends or publishes; nothing goes to a network.
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
  ANGLE_MAX,
  ANIM_MAX_S,
  FILTERS,
  MAX_TYPEWRITER_TEXTS,
  ROTATIONS,
  addClip,
  addText,
  setCrossfade,
  newDocForAsset,
  toDoc,
  toModel,
  validateTimeline,
  type EditorAsset,
  type TimelineDoc,
} from "@/lib/editor";
import { ANIM_REST } from "@/lib/editorFxPreview";

const te = en.editor;
const fxe = en.editor.fx;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333";
const VIDEO: EditorAsset = { id: A, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080, viewUrl: "/v/a", thumbUrl: null };
const NOSIZE: EditorAsset = { id: B, kind: "video", name: "mystery.mp4", durationS: 4, width: null, height: null, viewUrl: "/v/b", thumbUrl: null };
const LOGO: EditorAsset = { id: P, kind: "image", name: "logo.png", durationS: null, width: 400, height: 200, viewUrl: "/p/logo", thumbUrl: null };

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

function mount(doc: TimelineDoc, locale: "en" | "ru" | "uz" = "en") {
  return render(
    <I18nProvider locale={locale}>
      <TimelineEditor projectId={PID} title="Trip" rev={1} doc={doc} exports={[]}
        assets={{ [A]: VIDEO, [B]: NOSIZE, [P]: LOGO }} videos={[VIDEO, NOSIZE]} imageFiles={[LOGO]} userId="user-1" />
    </I18nProvider>,
  );
}
const videoDoc = () => newDocForAsset(VIDEO)!;
const textDoc = () => toDoc(addText(toModel(videoDoc()), 0, "Day one")!.model);
const overlayDoc = (extra: Record<string, unknown> = {}): TimelineDoc => ({
  ...videoDoc(),
  overlays: [{ id: "o1", asset_id: P, start_s: 1, end_s: 4, x: 0.5, y: 0.5, w: 0.3, opacity: 1, ...extra }],
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
const radio = (scope: HTMLElement, name: string) => within(scope).getByRole("radio", { name }) as HTMLInputElement;
const slider = (scope: HTMLElement, name: RegExp | string) => within(scope).getByRole("slider", { name }) as HTMLInputElement;
const setSlider = (el: HTMLInputElement, v: number) => fireEvent.change(el, { target: { value: String(v) } });
const clip0 = (d: TimelineDoc) => d.tracks[0].clips[0] as Record<string, unknown>;
const pictureEl = () => document.querySelector("[data-editor-preview-pin] video, [data-editor-preview-pin] img") as HTMLElement;

describe("the Look and effects section", () => {
  it("is shut for a plain clip and open for one that already has an effect", () => {
    mount(videoDoc());
    expect((screen.getByText(fxe.effects.title).closest("details") as HTMLDetailsElement).open).toBe(false);
    cleanup();
    const d = videoDoc();
    (d.tracks[0].clips[0] as Record<string, unknown>).blur = 5;
    mount(d);
    expect((screen.getByText(fxe.effects.title).closest("details") as HTMLDetailsElement).open).toBe(true);
  });

  it("offers every look of the document as a native radio in one named group, none lit", () => {
    mount(videoDoc());
    const s = section(fxe.effects.title);
    const group = within(s).getByRole("group", { name: fxe.effects.lookLegend });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(FILTERS.length + 1);
    expect(radios.map((r) => r.value)).toEqual(["none", ...FILTERS]);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios.filter((r) => r.checked).map((r) => r.value)).toEqual(["none"]);
    for (const r of radios) {
      expect(r.parentElement!.className).toContain("ns-chip");
      expect(r.parentElement!.hasAttribute("data-radio")).toBe(true);
      expect((r.parentElement as HTMLElement).style.minHeight).toBe("2.75rem");
    }
    // a name for every look
    for (const f of FILTERS) expect(radio(s, fxe.effects.looks[f])).toBeTruthy();
  });

  it("choosing a look: the preview takes its filter, a strength appears, undo goes back, Save sends it", async () => {
    mount(videoDoc());
    const s = section(fxe.effects.title);
    expect(within(s).queryByRole("slider", { name: fxe.effects.strength })).toBeNull();
    fireEvent.click(radio(s, fxe.effects.looks.sepia));
    expect(radio(s, fxe.effects.looks.sepia).checked).toBe(true);
    expect(pictureEl().style.filter).toContain("url(#ns-clip-look)");
    expect(document.querySelector("[data-testid=look-filter] feColorMatrix")).toBeTruthy();
    expect(screen.getByText(te.unsaved)).toBeTruthy();
    setSlider(slider(s, fxe.effects.strength), 0.4);
    expect(document.querySelector("[data-testid=look-filter] feColorMatrix")!.getAttribute("values")).toContain("0.");
    const doc = await save();
    expect(clip0(doc)).toMatchObject({ filter: "sepia", filter_strength: 0.4 });
    expect(validateTimeline(doc)).toEqual([]);
    undo();
    undo();
    // the look is gone from the picture; the saved copy has it, so this is unsaved again
    expect(radio(section(fxe.effects.title), fxe.effects.looks.sepia).checked).toBe(false);
    expect(pictureEl().style.filter).toBe("");
    expect(screen.getByText(te.unsaved)).toBeTruthy();
  });

  it("each curve look is drawn with per-channel tables, mono with a saturate", () => {
    mount(videoDoc());
    const s = section(fxe.effects.title);
    fireEvent.click(radio(s, fxe.effects.looks.cinematic));
    expect(document.querySelectorAll("[data-testid=look-filter] feFuncR, [data-testid=look-filter] feFuncG, [data-testid=look-filter] feFuncB")).toHaveLength(3);
    fireEvent.click(radio(s, fxe.effects.looks.mono));
    expect(document.querySelector("[data-testid=look-filter] feColorMatrix")!.getAttribute("type")).toBe("saturate");
  });

  it("a strength drag is ONE undo step; None removes the look and its strength", () => {
    mount(videoDoc());
    const s = section(fxe.effects.title);
    fireEvent.click(radio(s, fxe.effects.looks.warm));
    const st = slider(s, fxe.effects.strength);
    fireEvent.pointerDown(st);
    setSlider(st, 0.8);
    setSlider(st, 0.6);
    setSlider(st, 0.3);
    undo();
    // one undo goes back past the whole drag, to the look at full strength
    expect(radio(section(fxe.effects.title), fxe.effects.looks.warm).checked).toBe(true);
    expect(within(section(fxe.effects.title)).getByRole("slider", { name: fxe.effects.strength })).toHaveProperty("value", "1");
    fireEvent.click(radio(within(section(fxe.effects.title)).getByRole("group", { name: fxe.effects.lookLegend }), fxe.effects.lookNone));
    // the look and its strength are both gone: the document is the one that was opened
    expect(screen.getByText(te.saved)).toBeTruthy();
    expect(screen.queryByRole("slider", { name: fxe.effects.strength })).toBeNull();
  });

  it("sliders: vignette, blur, sharpen and grain use the document's own ranges and write only what is on", async () => {
    mount(videoDoc());
    const s = section(fxe.effects.title);
    const blur = slider(s, fxe.effects.blur);
    expect(Number(blur.max)).toBe(30);
    expect(Number(blur.min)).toBe(0);
    expect(Number(slider(s, fxe.effects.vignette).max)).toBe(1);
    setSlider(blur, 12);
    setSlider(slider(s, fxe.effects.vignette), 0.5);
    setSlider(slider(s, fxe.effects.grain), 0.25);
    setSlider(slider(s, fxe.effects.sharpen), 0.35);
    // blur is a CSS blur in a share of the frame; the vignette draws a shade; sharpen and grain are not drawn
    const stage = document.querySelector("[data-testid=clip-stage]") as HTMLElement;
    expect((stage.firstElementChild as HTMLElement).style.filter).toContain("blur(");
    expect(document.querySelector("[data-testid=clip-vignette]")).toBeTruthy();
    expect(screen.getByText(fxe.effects.hint)).toBeTruthy();
    const doc = await save();
    expect(clip0(doc)).toMatchObject({ blur: 12, vignette: 0.5, grain: 0.25, sharpen: 0.35 });
    expect(validateTimeline(doc)).toEqual([]);
    setSlider(blur, 0);
    setSlider(slider(s, fxe.effects.vignette), 0);
    expect(document.querySelector("[data-testid=clip-vignette]")).toBeNull();
  });

  it("says so when sharpen or grain is on: they are not drawn in the preview", () => {
    mount(videoDoc());
    const s = section(fxe.effects.title);
    expect(within(s).queryByText(fxe.effects.notDrawn)).toBeNull();
    setSlider(slider(s, fxe.effects.grain), 0.4);
    expect(within(s).getByText(fxe.effects.notDrawn)).toBeTruthy();
    setSlider(slider(s, fxe.effects.grain), 0);
    expect(within(s).queryByText(fxe.effects.notDrawn)).toBeNull();
  });

  it("every slider is a 44px row and has an accessible name and value text", () => {
    mount(videoDoc());
    const s = section(fxe.effects.title);
    for (const label of [fxe.effects.vignette, fxe.effects.blur, fxe.effects.sharpen, fxe.effects.grain]) {
      const el = slider(s, label);
      expect(el.className).toContain("h-11");
      expect(el.getAttribute("aria-valuetext")).toBeTruthy();
    }
    expect(slider(s, fxe.effects.blur).getAttribute("aria-valuetext")).toBe(fmt(fxe.effects.blurValue, { v: 0 }));
  });

  it("mirror and turn: the stage appears, turns, and Save carries them; the quarter turns are a radio group", async () => {
    mount(videoDoc());
    expect(document.querySelector("[data-testid=clip-stage]")).toBeNull();
    const s = section(fxe.effects.title);
    fireEvent.click(within(s).getByRole("checkbox", { name: fxe.effects.flipH }));
    fireEvent.click(within(s).getByRole("checkbox", { name: fxe.effects.flipV }));
    const group = within(s).getByRole("group", { name: fxe.effects.turnLegend });
    expect(within(group).getAllByRole("radio")).toHaveLength(ROTATIONS.length);
    fireEvent.click(radio(group, fxe.effects.turns["90"]));
    const stage = document.querySelector("[data-testid=clip-stage]") as HTMLElement;
    expect(stage).toBeTruthy();
    expect(pictureEl().style.transform).toBe("translate(-50%, -50%) scaleX(-1) scaleY(-1) rotate(90deg)");
    const doc = await save();
    expect(clip0(doc)).toMatchObject({ flip_h: true, flip_v: true, rotate: 90 });
    expect(validateTimeline(doc)).toEqual([]);
    expect(screen.getByText(fxe.effects.turnHint)).toBeTruthy();
  });

  it("Remove all effects goes back to the document it was, and is one undo step", async () => {
    const before = JSON.stringify(toDoc(toModel(videoDoc())));
    mount(videoDoc());
    const s = section(fxe.effects.title);
    fireEvent.click(radio(s, fxe.effects.looks.vintage));
    setSlider(slider(s, fxe.effects.blur), 8);
    fireEvent.click(within(s).getByRole("checkbox", { name: fxe.effects.flipH }));
    fireEvent.click(within(s).getByRole("button", { name: fxe.effects.reset }));
    expect(document.querySelector("[data-testid=clip-stage]")).toBeNull();
    // the document is the one that was opened: nothing to save
    expect(screen.getByText(te.saved)).toBeTruthy();
    expect(JSON.stringify(toDoc(toModel(videoDoc())))).toBe(before);
    undo();
    expect(radio(section(fxe.effects.title), fxe.effects.looks.vintage).checked).toBe(true);
    expect(Number(slider(section(fxe.effects.title), fxe.effects.blur).value)).toBe(8);
  });

  it("works on a photo too (effects are for pictures)", () => {
    const photo: TimelineDoc = {
      ...videoDoc(),
      tracks: [{ id: "v1", kind: "V", clips: [{ id: "c1", asset_id: P, start_s: 0, in_s: 0, out_s: 5 }] }],
    };
    mount(photo);
    const s = section(fxe.effects.title);
    fireEvent.click(radio(s, fxe.effects.looks.cool));
    expect(document.querySelector("[data-editor-preview-pin] img")!.getAttribute("style")).toContain("ns-clip-look");
  });

  it("is carried by the local draft", () => {
    vi.useFakeTimers();
    mount(videoDoc());
    fireEvent.click(radio(section(fxe.effects.title), fxe.effects.looks.mono));
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS + 50);
    const back = readDraft("user-1", PID, 1);
    expect(clip0(back!.doc)).toMatchObject({ filter: "mono" });
    expect(validateTimeline(back!.doc)).toEqual([]);
  });

  it("an opened document keeps effects it holds and saves them back unchanged", async () => {
    const d = videoDoc();
    Object.assign(d.tracks[0].clips[0], { filter: "warm", filter_strength: 0.5, vignette: 0.3, flip_v: true, rotate: 180 });
    mount(d);
    fireEvent.change(screen.getByRole("textbox", { name: te.projectTitle }), { target: { value: "Trip 2" } });
    const doc = await save();
    expect(clip0(doc)).toMatchObject({ filter: "warm", filter_strength: 0.5, vignette: 0.3, flip_v: true, rotate: 180 });
  });
});

describe("blur on a cross-faded clip in a frame above 1440p", () => {
  const bigDoc = (): TimelineDoc => {
    const m = addClip(toModel(videoDoc()), VIDEO);
    const d = toDoc(setCrossfade({ ...m, width: 3840, height: 2160 }, m.clips[1].id, 1));
    return d;
  };
  it("the blur slider is off with the reason and the frame size; the other effects still work", () => {
    mount(bigDoc());
    const s = section(fxe.effects.title);
    expect(slider(s, fxe.effects.blur).disabled).toBe(true);
    expect(Number(slider(s, fxe.effects.blur).max)).toBe(0);
    expect(within(s).getByTestId("blur-large").textContent).toBe(fmt(fxe.effects.largeBlur, { w: 3840, h: 2160 }));
    expect(slider(s, fxe.effects.vignette).disabled).toBe(false);
    cleanup();
    mount(videoDoc());
    expect(within(section(fxe.effects.title)).queryByTestId("blur-large")).toBeNull();
  });
  it("a normal frame keeps its blur even with a cross-fade", () => {
    const m = addClip(toModel(videoDoc()), VIDEO);
    mount(toDoc(setCrossfade(m, m.clips[1].id, 1)));
    expect(slider(section(fxe.effects.title), fxe.effects.blur).disabled).toBe(false);
  });
});

describe("the Crop and tilt section", () => {
  it("shows the kept part as a labelled drawing and the shapes as a radio group, Whole picture lit", () => {
    mount(videoDoc());
    const s = section(fxe.crop.title);
    expect(within(s).getByRole("img", { name: fmt(fxe.crop.map, { x: 0, y: 0, w: 100, h: 100 }) })).toBeTruthy();
    const group = within(s).getByRole("group", { name: fxe.crop.shapeLegend });
    expect(within(group).getAllByRole("radio")).toHaveLength(Object.keys(fxe.crop.shapes).length);
    expect(radio(group, fxe.crop.shapes.whole).checked).toBe(true);
  });

  it("a shape crops to a centred rectangle, lights its key, redraws the preview, and Save sends it", async () => {
    mount(videoDoc());
    const s = section(fxe.crop.title);
    fireEvent.click(radio(s, fxe.crop.shapes.square));
    expect(radio(s, fxe.crop.shapes.square).checked).toBe(true);
    expect(radio(s, fxe.crop.shapes.whole).checked).toBe(false);
    expect(document.querySelector("[data-testid=clip-stage]")).toBeTruthy();
    const doc = await save();
    expect(clip0(doc).crop).toEqual({ x: 0.219, y: 0, w: 0.563, h: 1 });
    expect(validateTimeline(doc)).toEqual([]);
    expect(within(s).getByRole("img").getAttribute("aria-label")).toBe(fmt(fxe.crop.map, { x: 22, y: 0, w: 56, h: 100 }));
  });

  it("the four sliders keep the rectangle inside the picture; moving one by hand lights no shape", () => {
    mount(videoDoc());
    const s = section(fxe.crop.title);
    const w = slider(s, fxe.crop.width);
    expect(Number(w.min)).toBe(0.05);
    expect(Number(w.max)).toBe(1);
    setSlider(w, 0.5);
    // the left edge can now only go as far as the rectangle fits
    expect(Number(slider(s, fxe.crop.left).max)).toBe(0.5);
    setSlider(slider(s, fxe.crop.left), 0.5);
    setSlider(w, 0.8);
    expect(Number(slider(s, fxe.crop.left).value)).toBe(0.2);
    expect(within(s).getAllByRole("radio").every((r) => !(r as HTMLInputElement).checked)).toBe(true);
  });

  it("Whole picture / Reset removes the crop; one undo brings the crop back", async () => {
    mount(videoDoc());
    const s = section(fxe.crop.title);
    fireEvent.click(radio(s, fxe.crop.shapes.tall));
    fireEvent.click(within(s).getByRole("button", { name: fxe.crop.reset }));
    expect(document.querySelector("[data-testid=clip-stage]")).toBeNull();
    expect(screen.getByText(te.saved)).toBeTruthy();
    undo();
    expect(radio(section(fxe.crop.title), fxe.crop.shapes.tall).checked).toBe(true);
  });

  it("a quarter turn changes what a shape means (the turned picture's sides swap)", async () => {
    mount(videoDoc());
    fireEvent.click(radio(section(fxe.effects.title), fxe.effects.turns["90"]));
    const s = section(fxe.crop.title);
    fireEvent.click(radio(s, fxe.crop.shapes.tall));
    // a 9:16 shape of a turned (portrait) picture is the whole picture
    expect(clip0(await save()).crop).toBeUndefined();
  });

  it("a file whose size is not known cannot be cropped to a shape: the keys are off and the reason is said", () => {
    const doc = toDoc(addClip(toModel(videoDoc()), NOSIZE));
    mount(doc);
    fireEvent.click(screen.getByRole("button", { name: /Clip 2|mystery/ }));
    const s = section(fxe.crop.title);
    expect(radio(s, fxe.crop.shapes.square).disabled).toBe(true);
    expect(radio(s, fxe.crop.shapes.whole).disabled).toBe(false);
    expect(within(s).getByText(fxe.crop.unknownSize)).toBeTruthy();
    // the sliders still work
    setSlider(slider(s, fxe.crop.width), 0.5);
    expect(screen.getByText(te.unsaved)).toBeTruthy();
  });

  it("the free angle: slider and number box share the document's range; it is one undo step per drag; Straighten removes it", async () => {
    mount(videoDoc());
    const s = section(fxe.crop.title);
    const a = slider(s, fxe.crop.angle);
    expect(Number(a.min)).toBe(-ANGLE_MAX);
    expect(Number(a.max)).toBe(ANGLE_MAX);
    fireEvent.pointerDown(a);
    setSlider(a, 10);
    setSlider(a, 25);
    expect(pictureEl().parentElement!.parentElement!.parentElement!.style.transform).toContain("rotate(25deg)");
    undo();
    expect(Number(slider(section(fxe.crop.title), fxe.crop.angle).value)).toBe(0);
    setSlider(slider(section(fxe.crop.title), fxe.crop.angle), 30);
    const box = within(section(fxe.crop.title)).getByRole("spinbutton", { name: fxe.crop.angle }) as HTMLInputElement;
    expect(box.value).toBe("30");
    fireEvent.change(box, { target: { value: "999" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(clip0(await save()).angle).toBe(ANGLE_MAX);
    fireEvent.click(within(section(fxe.crop.title)).getByRole("button", { name: fxe.crop.angleReset }));
    expect(Number(slider(section(fxe.crop.title), fxe.crop.angle).value)).toBe(0);
    expect(screen.getByText(fxe.crop.angleHint)).toBeTruthy();
  });

  it("crop and angle are carried by the local draft", () => {
    vi.useFakeTimers();
    mount(videoDoc());
    fireEvent.click(radio(section(fxe.crop.title), fxe.crop.shapes.square));
    setSlider(slider(section(fxe.crop.title), fxe.crop.angle), -15);
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS + 50);
    const c = clip0(readDraft("user-1", PID, 1)!.doc);
    expect(c.crop).toBeTruthy();
    expect(c.angle).toBe(-15);
  });
});

describe("entrance and exit of a text", () => {
  const selectText = () => fireEvent.click(within(screen.getByRole("list", { name: te.textTrack })).getByRole("button"));
  const textClip = (d: TimelineDoc) => d.tracks.find((t) => t.kind === "T")!.clips[0] as Record<string, unknown>;

  it("offers the six animations on both sides and the typewriter on the entrance only", () => {
    mount(textDoc());
    selectText();
    const s = section(fxe.anim.title);
    const inn = within(s).getByRole("group", { name: fxe.anim.inLegend });
    const out = within(s).getByRole("group", { name: fxe.anim.outLegend });
    expect(within(inn).getAllByRole("radio")).toHaveLength(8);
    expect(within(out).getAllByRole("radio")).toHaveLength(7);
    expect(within(out).queryByRole("radio", { name: fxe.anim.names.typewriter })).toBeNull();
    expect(radio(inn, fxe.anim.none).checked).toBe(true);
    expect(within(s).queryByRole("slider")).toBeNull();
  });

  it("choosing an entrance: a length slider appears, the document gets the field, undo removes it", async () => {
    mount(textDoc());
    selectText();
    const s = section(fxe.anim.title);
    fireEvent.click(radio(within(s).getByRole("group", { name: fxe.anim.inLegend }), fxe.anim.names.pop));
    const len = slider(s, fxe.anim.inLength);
    expect(Number(len.min)).toBe(0.1);
    expect(Number(len.max)).toBeLessThanOrEqual(ANIM_MAX_S);
    setSlider(len, 1.2);
    const doc = await save();
    expect(textClip(doc)).toMatchObject({ anim_in: "pop", anim_in_s: 1.2 });
    expect(validateTimeline(doc)).toEqual([]);
    undo();
    undo();
    expect(radio(within(section(fxe.anim.title), ).getByRole("group", { name: fxe.anim.inLegend }), fxe.anim.none).checked).toBe(true);
  });

  it("the typewriter writes the text letter by letter in the preview at the playhead", () => {
    mount(textDoc());
    selectText();
    const s = section(fxe.anim.title);
    fireEvent.click(radio(within(s).getByRole("group", { name: fxe.anim.inLegend }), fxe.anim.names.typewriter));
    // the playhead is at 0: nothing is written yet, but the final text is there, unseen
    const span = Array.from(document.querySelectorAll("[data-editor-preview-pin] span")).find((x) => x.textContent === "Day one") as HTMLElement;
    expect(span).toBeTruthy();
    expect((span.querySelector("span") as HTMLElement).style.visibility).toBe("hidden");
  });

  it("an entrance lowers the text's opacity at the playhead; at rest it is untouched", () => {
    mount(textDoc());
    selectText();
    fireEvent.click(radio(within(section(fxe.anim.title)).getByRole("group", { name: fxe.anim.inLegend }), fxe.anim.names.fade));
    const span = Array.from(document.querySelectorAll("[data-editor-preview-pin] span")).find((x) => x.textContent === "Day one") as HTMLElement;
    expect(span.style.opacity).toBe("0");
    expect(ANIM_REST.opacity).toBe(1);
  });

  it("a plain fade on the text is replaced and the user is told", async () => {
    const d = textDoc();
    Object.assign(textClip(d), { fade_in_s: 0.5 });
    mount(d);
    selectText();
    const s = section(fxe.anim.title);
    expect(within(s).getByText(fxe.anim.replacesFade)).toBeTruthy();
    fireEvent.click(radio(within(s).getByRole("group", { name: fxe.anim.inLegend }), fxe.anim.names["slide-up"]));
    const doc = await save();
    expect(textClip(doc).fade_in_s).toBeUndefined();
    expect(textClip(doc).anim_in).toBe("slide-up");
    expect(validateTimeline(doc)).toEqual([]);
  });

  it("a short text has no room for both: the second side is off, the reason is said and nothing invalid can be saved", async () => {
    const d = textDoc();
    Object.assign(textClip(d), { start_s: 0, end_s: 0.5 });
    mount(d);
    selectText();
    const s = section(fxe.anim.title);
    const inn = within(s).getByRole("group", { name: fxe.anim.inLegend });
    fireEvent.click(radio(inn, fxe.anim.names.fade));
    fireEvent.click(radio(within(s).getByRole("group", { name: fxe.anim.outLegend }), fxe.anim.names.pop));
    const doc = await save();
    expect(validateTimeline(doc)).toEqual([]);
    // 0.5 s: 0.4 in + 0.1 out is the most there is; a third request has no room
    expect(textClip(doc)).toMatchObject({ anim_in_s: 0.4, anim_out_s: 0.1 });
    fireEvent.click(radio(inn, fxe.anim.names.fade));
    expect(within(s).queryByText(new RegExp("Not enough time"))).toBeNull();
  });

  it("with no time at all for the other side its keys are disabled with the reason", () => {
    const d = textDoc();
    Object.assign(textClip(d), { start_s: 0, end_s: 0.3 });
    mount(d);
    selectText();
    const s = section(fxe.anim.title);
    fireEvent.click(radio(within(s).getByRole("group", { name: fxe.anim.inLegend }), fxe.anim.names.fade));
    const out = within(s).getByRole("group", { name: fxe.anim.outLegend });
    expect(radio(out, fxe.anim.names.pop).disabled).toBe(true);
    expect(radio(out, fxe.anim.none).disabled).toBe(false);
    expect(within(s).getByText(fmt(fxe.anim.noRoom, { shown: 0.3 }))).toBeTruthy();
  });

  it("shortening the text shortens its animation with it", async () => {
    mount(textDoc());
    selectText();
    const s = section(fxe.anim.title);
    fireEvent.click(radio(within(s).getByRole("group", { name: fxe.anim.inLegend }), fxe.anim.names.fade));
    setSlider(slider(s, fxe.anim.inLength), 2);
    const end = screen.getByRole("spinbutton", { name: te.textEnd });
    fireEvent.change(end, { target: { value: "0.5" } });
    fireEvent.blur(end);
    const doc = await save();
    expect(validateTimeline(doc)).toEqual([]);
    expect(Number(textClip(doc).anim_in_s)).toBeLessThanOrEqual(0.5);
  });

  it("the typewriter is off past the project's limit, with the limit said", () => {
    let m = toModel(videoDoc());
    for (let i = 0; i < MAX_TYPEWRITER_TEXTS + 1; i += 1) {
      const out = addText(m, 0, `T${i}`)!;
      m = out.model;
    }
    const d = toDoc(m);
    d.tracks.filter((t) => t.kind === "T").slice(0, MAX_TYPEWRITER_TEXTS).forEach((t) => Object.assign(t.clips[0], { anim_in: "typewriter", anim_in_s: 0.4 }));
    mount(d);
    // the last text is the 21st
    const items = within(screen.getByRole("list", { name: te.textTrack })).getAllByRole("button");
    fireEvent.click(items[items.length - 1]);
    const s = section(fxe.anim.title);
    const inn = within(s).getByRole("group", { name: fxe.anim.inLegend });
    expect(radio(inn, fxe.anim.names.typewriter).disabled).toBe(true);
    expect(radio(inn, fxe.anim.names.fade).disabled).toBe(false);
    expect(within(s).getByText(fmt(fxe.anim.typewriterFull, { max: MAX_TYPEWRITER_TEXTS }))).toBeTruthy();
    // one that has it keeps it
    fireEvent.click(items[0]);
    expect(radio(within(section(fxe.anim.title)).getByRole("group", { name: fxe.anim.inLegend }), fxe.anim.names.typewriter).disabled).toBe(false);
  });

  it("states what the preview does and that the export is the reference", () => {
    mount(textDoc());
    selectText();
    const s = section(fxe.anim.title);
    expect(s.textContent).toContain("the exported file is the reference");
    expect(s.textContent).toContain("15%");
    expect(s.textContent).toContain("60%");
  });

  it("is carried by the local draft", () => {
    vi.useFakeTimers();
    mount(textDoc());
    selectText();
    fireEvent.click(radio(within(section(fxe.anim.title)).getByRole("group", { name: fxe.anim.outLegend }), fxe.anim.names["slide-down"]));
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS + 50);
    expect(textClip(readDraft("user-1", PID, 1)!.doc)).toMatchObject({ anim_out: "slide-down" });
  });
});

describe("entrance and exit of an overlay", () => {
  const selectOverlay = () => fireEvent.click(screen.getByRole("button", { name: /logo\.png/ }));
  const ov = (d: TimelineDoc) => (d.overlays as Record<string, unknown>[])[0];

  it("a picture gets no typewriter; its animation is saved with the overlay and undone", async () => {
    mount(overlayDoc());
    selectOverlay();
    const s = section(fxe.anim.title);
    expect(within(s).queryByRole("radio", { name: fxe.anim.names.typewriter })).toBeNull();
    fireEvent.click(radio(within(s).getByRole("group", { name: fxe.anim.outLegend }), fxe.anim.names["slide-left"]));
    const doc = await save();
    expect(ov(doc)).toMatchObject({ anim_out: "slide-left", anim_out_s: 0.4 });
    expect(validateTimeline(doc)).toEqual([]);
    undo();
    expect(screen.getByText(te.unsaved)).toBeTruthy();
    expect(radio(within(section(fxe.anim.title)).getByRole("group", { name: fxe.anim.outLegend }), fxe.anim.none).checked).toBe(true);
  });

  it("an overlay shown for a moment keeps its animations inside that time", async () => {
    mount(overlayDoc({ start_s: 0, end_s: 0.6 }));
    selectOverlay();
    const s = section(fxe.anim.title);
    fireEvent.click(radio(within(s).getByRole("group", { name: fxe.anim.inLegend }), fxe.anim.names.pop));
    fireEvent.click(radio(within(s).getByRole("group", { name: fxe.anim.outLegend }), fxe.anim.names.fade));
    const doc = await save();
    expect(validateTimeline(doc)).toEqual([]);
    expect(Number(ov(doc).anim_in_s) + Number(ov(doc).anim_out_s)).toBeLessThanOrEqual(0.6 + 1e-9);
  });

  it("the preview moves the overlay at the playhead: its box is offset during an entrance", () => {
    mount(overlayDoc({ start_s: 0, end_s: 4, anim_in: "slide-right", anim_in_s: 1 }));
    selectOverlay();
    const el = document.querySelector<HTMLElement>("[data-overlay]")!;
    // the playhead is at 0: the very start of the entrance, fully transparent and moved
    expect(el.style.opacity).toBe("0");
    expect(el.style.transform).toContain("cqw");
  });

  it("a document that has animations opens with them and saves them back", async () => {
    const d = overlayDoc({ anim_in: "fade", anim_in_s: 0.7, anim_out: "pop", anim_out_s: 0.3 });
    mount(d);
    fireEvent.change(screen.getByRole("textbox", { name: te.projectTitle }), { target: { value: "x" } });
    const doc = await save();
    expect(ov(doc)).toMatchObject({ anim_in: "fade", anim_in_s: 0.7, anim_out: "pop", anim_out_s: 0.3 });
  });
});

describe("words", () => {
  const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
  const walk = (a: unknown, b: unknown, path: string, out: string[]) => {
    if (typeof a === "string") {
      if (typeof b !== "string") out.push(`${path}: not a string`);
      else if (holes(a) !== holes(b)) out.push(`${path}: placeholders differ`);
      else if (!b.trim()) out.push(`${path}: empty`);
      return;
    }
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys((b ?? {}) as object).sort();
    if (ka.join() !== kb.join()) out.push(`${path}: keys differ`);
    for (const k of ka) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)?.[k], `${path}.${k}`, out);
  };
  it("ru and uz have every string en has, with the same placeholders", () => {
    for (const [name, d] of [["ru", ru], ["uz", uz]] as const) {
      const problems: string[] = [];
      walk(en.editor.fx, d.editor.fx, `${name}.fx`, problems);
      expect(problems).toEqual([]);
    }
  });
  it("ru and uz are translated (not the English), and Uzbek uses the modifier apostrophe", () => {
    for (const d of [ru, uz]) {
      expect(d.editor.fx.effects.title).not.toBe(en.editor.fx.effects.title);
      expect(d.editor.fx.crop.title).not.toBe(en.editor.fx.crop.title);
      expect(d.editor.fx.anim.title).not.toBe(en.editor.fx.anim.title);
    }
    const all = JSON.stringify(uz.editor.fx);
    expect(all).not.toMatch(/[a-z]'[a-z]/i);
  });
  it("no provider or brand names and no role words in the new copy", () => {
    for (const d of [en, ru, uz]) {
      expect(JSON.stringify(d.editor.fx)).not.toMatch(/ffmpeg|capcut|higgsfield|krea|owner|viewer|editor|владелец|зритель|редактор|egasi|tahrirchi/i);
    }
  });
  it("the editor renders in ru and uz with the new sections named in that language", () => {
    for (const [loc, d] of [["ru", ru], ["uz", uz]] as const) {
      mount(videoDoc(), loc);
      expect(screen.getByText(d.editor.fx.effects.title)).toBeTruthy();
      expect(screen.getByText(d.editor.fx.crop.title)).toBeTruthy();
      cleanup();
    }
  });
  it("a text's section is named in ru and uz", () => {
    for (const [loc, d] of [["ru", ru], ["uz", uz]] as const) {
      mount(textDoc(), loc);
      fireEvent.click(within(screen.getByRole("list", { name: d.editor.textTrack })).getByRole("button"));
      expect(screen.getByText(d.editor.fx.anim.title)).toBeTruthy();
      cleanup();
    }
  });
});
