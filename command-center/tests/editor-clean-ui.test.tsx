// @vitest-environment jsdom
/**
 * Chroma key, sound clean-up and stabilise in the editor (UI half). What would
 * break without these: a key that is not in the document (or is, in a form the
 * validator refuses), a colour typed wrong and silently dropped, a limit not on
 * the screen with its number, a toggle that stays on when the document would
 * refuse it, a claim the engine cannot keep (stabilise is slower and crops; the
 * preview does not show it), a sentence missing in a language, or a document
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
  CHROMA_BLEND_DEFAULT,
  CHROMA_BLEND_MAX,
  CHROMA_SIMILARITY_DEFAULT,
  CHROMA_SIMILARITY_MAX,
  CHROMA_SIMILARITY_MIN,
  STABILIZE_MAX_DOC_S,
  STABILIZE_MAX_S,
  addSound,
  newDocForAsset,
  toDoc,
  toModel,
  validateTimeline,
  type EditorAsset,
  type TimelineDoc,
} from "@/lib/editor";

const te = en.editor;
const fxe = en.editor.fx;
const ck = fxe.chroma;
const cl = fxe.clean;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const L = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333";
const S = "44444444-4444-4444-8444-444444444444";
const G = "55555555-5555-4555-8555-555555555555";
const VIDEO: EditorAsset = { id: A, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080, viewUrl: "/v/a", thumbUrl: null };
const LONG: EditorAsset = { id: L, kind: "video", name: "long.mp4", durationS: 400, width: 1920, height: 1080, viewUrl: "/v/l", thumbUrl: null };
const PHOTO: EditorAsset = { id: P, kind: "image", name: "logo.png", durationS: null, width: 400, height: 200, viewUrl: "/p/logo", thumbUrl: null };
const SOUND: EditorAsset = { id: S, kind: "audio", name: "tune.mp3", durationS: 20, width: null, height: null, viewUrl: "/s/t", thumbUrl: null };
const SCREEN: EditorAsset = { id: G, kind: "video", name: "greenscreen.mp4", durationS: 5, width: 1280, height: 720, viewUrl: "/v/g", thumbUrl: null };

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
  delete (window as unknown as { EyeDropper?: unknown }).EyeDropper;
});

function mount(doc: TimelineDoc, locale: "en" | "ru" | "uz" = "en") {
  return render(
    <I18nProvider locale={locale}>
      <TimelineEditor projectId={PID} title="Trip" rev={1} doc={doc} exports={[]}
        assets={{ [A]: VIDEO, [L]: LONG, [P]: PHOTO, [S]: SOUND, [G]: SCREEN }}
        videos={[VIDEO, LONG, SCREEN]} soundFiles={[SOUND]} imageFiles={[PHOTO]} userId="user-1" />
    </I18nProvider>,
  );
}
const videoDoc = (clip: Record<string, unknown> = {}): TimelineDoc => {
  const d = newDocForAsset(VIDEO)!;
  Object.assign(d.tracks[0].clips[0], clip);
  return d;
};
const longDoc = (range: number): TimelineDoc => {
  const d = newDocForAsset(LONG)!;
  Object.assign(d.tracks[0].clips[0], { out_s: range });
  return d;
};
const photoDoc = (): TimelineDoc => ({
  ...videoDoc(),
  tracks: [{ id: "v1", kind: "V", clips: [{ id: "c1", asset_id: P, start_s: 0, in_s: 0, out_s: 5 }] }],
});
const overlayDoc = (asset: string, extra: Record<string, unknown> = {}): TimelineDoc => ({
  ...videoDoc(),
  overlays: [{ id: "o1", asset_id: asset, start_s: 0, end_s: 4, x: 0.5, y: 0.5, w: 0.3, opacity: 1, ...extra }],
});
const soundDoc = (): TimelineDoc => toDoc(addSound(toModel(videoDoc()), SOUND, 0)!.model);
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
const check = (scope: HTMLElement, name: RegExp | string) => within(scope).getByRole("checkbox", { name }) as HTMLInputElement;
const clip0 = (d: TimelineDoc) => d.tracks[0].clips[0] as Record<string, unknown>;
const ov = (d: TimelineDoc) => (d.overlays as Record<string, unknown>[])[0];
const selectOverlay = () => fireEvent.click(screen.getByRole("button", { name: /logo\.png|greenscreen/ }));
const chroma = () => section(ck.title);
const clean = () => section(cl.title);

describe("chroma key", () => {
  it("is off until asked; turning it on saves a key (green), draws the filter, and undo returns the document", async () => {
    mount(overlayDoc(P));
    selectOverlay();
    expect(check(chroma(), ck.toggle).checked).toBe(false);
    expect(document.querySelector("[data-testid=chroma-filter]")).toBeNull();
    fireEvent.click(check(chroma(), ck.toggle));
    expect(check(chroma(), ck.toggle).checked).toBe(true);
    expect(radio(chroma(), ck.green).checked).toBe(true);
    const item = document.querySelector("[data-overlay] img") as HTMLElement;
    expect(item.style.filter).toBe("url(#ns-chroma-o1)");
    expect(document.querySelector("#ns-chroma-o1")).toBeTruthy();
    const doc = await save();
    expect(ov(doc).chroma).toEqual({ color: "#00FF00" });
    expect(validateTimeline(doc)).toEqual([]);
    undo();
    expect(check(chroma(), ck.toggle).checked).toBe(false);
    expect((document.querySelector("[data-overlay] img") as HTMLElement).style.filter).toBe("");
  });

  it("works on a video overlay too: the filter sits on the video, which stays muted", () => {
    mount(overlayDoc(G, { chroma: { color: "#00FF00" } }));
    selectOverlay();
    const v = document.querySelector("[data-overlay] video") as HTMLVideoElement;
    expect(v.style.filter).toBe("url(#ns-chroma-o1)");
    expect(v.muted).toBe(true);
  });

  it("the colour: ready screens, the colour box, a typed code (upper-cased); a wrong code is said and not stored", async () => {
    mount(overlayDoc(P, { chroma: { color: "#00FF00" } }));
    selectOverlay();
    fireEvent.click(radio(chroma(), ck.blue));
    expect(radio(chroma(), ck.blue).checked).toBe(true);
    const box = within(chroma()).getByLabelText(ck.hex) as HTMLInputElement;
    expect(box.value).toBe("#0000FF");
    fireEvent.change(box, { target: { value: "#12ab" } });
    expect(within(chroma()).getByText(ck.badHex)).toBeTruthy();
    expect(box.getAttribute("aria-invalid")).toBe("true");
    fireEvent.blur(box);
    fireEvent.change(box, { target: { value: "#22aa33" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(within(chroma()).queryByText(ck.badHex)).toBeNull();
    // no ready screen is lit for a custom colour
    expect(radio(chroma(), ck.green).checked).toBe(false);
    expect(radio(chroma(), ck.blue).checked).toBe(false);
    const swatch = document.querySelector("input[type=color]") as HTMLInputElement;
    expect(swatch.value).toBe("#22aa33");
    fireEvent.change(swatch, { target: { value: "#ff00ff" } });
    expect(ov(await save()).chroma).toEqual({ color: "#FF00FF" });
  });

  it("how much and softness are sliders in the document's own ranges; a default is stored as nothing", async () => {
    mount(overlayDoc(P));
    selectOverlay();
    fireEvent.click(check(chroma(), ck.toggle));
    const sim = slider(chroma(), ck.similarity);
    expect(Number(sim.min)).toBe(CHROMA_SIMILARITY_MIN);
    expect(Number(sim.max)).toBe(CHROMA_SIMILARITY_MAX);
    expect(Number(sim.value)).toBe(CHROMA_SIMILARITY_DEFAULT);
    const blend = slider(chroma(), ck.blend);
    expect(Number(blend.min)).toBe(0);
    expect(Number(blend.max)).toBe(CHROMA_BLEND_MAX);
    expect(Number(blend.value)).toBe(CHROMA_BLEND_DEFAULT);
    fireEvent.pointerDown(sim);
    setSlider(sim, 0.3);
    setSlider(sim, 0.4);
    const filterValues = () => document.querySelector("#ns-chroma-o1 feFuncA")!.getAttribute("tableValues");
    const wide = filterValues();
    undo();
    // one drag is one undo step: back to the default softness and similarity
    expect(Number(slider(chroma(), ck.similarity).value)).toBe(CHROMA_SIMILARITY_DEFAULT);
    expect(filterValues()).not.toBe(wide);
    setSlider(slider(chroma(), ck.blend), 0.25);
    const doc = await save();
    expect(ov(doc).chroma).toEqual({ color: "#00FF00", blend: 0.25 });
    expect(validateTimeline(doc)).toEqual([]);
  });

  it("says what it does and does not do, and that the exported file is the reference", () => {
    mount(overlayDoc(P));
    selectOverlay();
    const s = chroma();
    expect(s.textContent).toContain(ck.hint);
    expect(ck.hint).toMatch(/fringes/);
    expect(ck.hint).toMatch(/exported file is the reference/);
  });

  it("offers the screen colour picker only where the browser has one, and uses it", async () => {
    mount(overlayDoc(P, { chroma: { color: "#00FF00" } }));
    selectOverlay();
    expect(within(chroma()).queryByRole("button", { name: ck.pick })).toBeNull();
    expect(within(chroma()).getByText(ck.pickUnsupported)).toBeTruthy();
    cleanup();
    (window as unknown as { EyeDropper: unknown }).EyeDropper = class {
      open() {
        return Promise.resolve({ sRGBHex: "#336699" });
      }
    };
    mount(overlayDoc(P, { chroma: { color: "#00FF00" } }));
    selectOverlay();
    fireEvent.click(within(chroma()).getByRole("button", { name: ck.pick }));
    await waitFor(() => expect((within(chroma()).getByLabelText(ck.hex) as HTMLInputElement).value).toBe("#336699"));
    expect(within(chroma()).getByText(ck.pickHint)).toBeTruthy();
  });

  it("a cancelled pick changes nothing", async () => {
    (window as unknown as { EyeDropper: unknown }).EyeDropper = class {
      open() {
        return Promise.reject(new Error("cancelled"));
      }
    };
    mount(overlayDoc(P, { chroma: { color: "#00FF00" } }));
    selectOverlay();
    fireEvent.click(within(chroma()).getByRole("button", { name: ck.pick }));
    await waitFor(() => expect(screen.getByText(te.saved)).toBeTruthy());
    expect((within(chroma()).getByLabelText(ck.hex) as HTMLInputElement).value).toBe("#00FF00");
  });

  it("opens on a saved key and saves it back unchanged; turning it off removes it; the draft carries it", async () => {
    const d = overlayDoc(P, { chroma: { color: "#0000FF", similarity: 0.3, blend: 0.2 } });
    mount(d);
    selectOverlay();
    expect((screen.getByText(ck.title).closest("details") as HTMLDetailsElement).open).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: te.projectTitle }), { target: { value: "x" } });
    expect(ov(await save()).chroma).toEqual({ color: "#0000FF", similarity: 0.3, blend: 0.2 });
    fireEvent.click(check(chroma(), ck.toggle));
    expect(screen.getByText(te.unsaved)).toBeTruthy();
    vi.useFakeTimers();
    fireEvent.click(check(chroma(), ck.toggle));
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS + 50);
    expect(ov(readDraft("user-1", PID, 2)?.doc ?? readDraft("user-1", PID, 1)!.doc).chroma).toBeTruthy();
  });
});

describe("clean up a clip's own sound", () => {
  it("denoise and loudness are toggles with honest explanations; saved, undone, carried by the draft", async () => {
    mount(videoDoc({ audio: true }));
    const s = clean();
    expect(s.textContent).toContain(cl.denoiseHint);
    expect(s.textContent).toContain(cl.loudnormHint);
    expect(cl.denoiseHint).toMatch(/does not remove all/);
    expect(cl.loudnormHint).toMatch(/approximate/);
    fireEvent.click(check(s, cl.denoise));
    fireEvent.click(check(clean(), cl.loudnorm));
    const doc = await save();
    expect(clip0(doc)).toMatchObject({ denoise: true, loudnorm: true });
    expect(validateTimeline(doc)).toEqual([]);
    undo();
    undo();
    expect(check(clean(), cl.denoise).checked).toBe(false);
    expect(check(clean(), cl.loudnorm).checked).toBe(false);
  });

  it("with the clip's sound off it says they do nothing yet", () => {
    mount(videoDoc({ audio: false }));
    expect(within(clean()).getByText(cl.soundOff)).toBeTruthy();
    cleanup();
    mount(videoDoc({ audio: true }));
    expect(within(clean()).queryByText(cl.soundOff)).toBeNull();
  });

  it("a music clip has the same two toggles in its own inspector", async () => {
    mount(soundDoc());
    fireEvent.click(within(screen.getByRole("list", { name: te.soundsTrack })).getAllByRole("button")[0]);
    const s = section(cl.soundTitle);
    fireEvent.click(check(s, cl.loudnorm));
    const doc = await save();
    const a = doc.tracks.find((t) => t.kind === "A")!.clips[0];
    expect(a).toMatchObject({ loudnorm: true });
    expect(validateTimeline(doc)).toEqual([]);
    expect(check(section(cl.soundTitle), cl.denoise).checked).toBe(false);
  });
});

describe("stabilise", () => {
  const toggle = () => check(clean(), cl.stabilize);

  it("states the cost honestly: slower export, edges cropped, the limits with their numbers, failure not hidden", () => {
    mount(videoDoc());
    const text = clean().textContent ?? "";
    expect(text).toContain(fmt(cl.stabilizeHint, { clipMax: STABILIZE_MAX_S, docMax: STABILIZE_MAX_DOC_S }));
    expect(cl.stabilizeHint).toMatch(/takes longer/);
    expect(cl.stabilizeHint).toMatch(/crops a little of the edges/);
    expect(cl.stabilizeHint).toMatch(/export fails/);
    expect(toggle().getAttribute("aria-describedby")).toBeTruthy();
  });

  it("turns on for a clip within the limits: saved, undone, and says how much of the project is used", async () => {
    mount(videoDoc());
    fireEvent.click(toggle());
    expect(toggle().checked).toBe(true);
    expect(clean().textContent).toContain(fmt(cl.stabilizeUsed, { used: 10, docMax: STABILIZE_MAX_DOC_S, range: 10 }));
    const doc = await save();
    expect(clip0(doc).stabilize).toBe(true);
    expect(validateTimeline(doc)).toEqual([]);
    undo();
    expect(toggle().checked).toBe(false);
  });

  it("is off for a part longer than the per-clip limit, with its length and the limit", () => {
    mount(longDoc(STABILIZE_MAX_S + 30));
    expect(toggle().disabled).toBe(true);
    expect(clean().textContent).toContain(fmt(cl.stabilizeClip, { range: STABILIZE_MAX_S + 30, max: STABILIZE_MAX_S }));
  });

  it("is off when the project's total would pass its limit, saying how much others use", () => {
    const d = longDoc(STABILIZE_MAX_S);
    Object.assign(d.tracks[0].clips[0], { stabilize: true });
    const clips = d.tracks[0].clips as Record<string, unknown>[];
    for (const [i, id] of ["c2", "c3"].entries()) {
      clips.push({ id, asset_id: L, start_s: STABILIZE_MAX_S * (i + 1), in_s: 0, out_s: STABILIZE_MAX_S, ...(i === 0 ? { stabilize: true } : {}) });
    }
    mount(d);
    const lane = within(screen.getByRole("list", { name: te.clipsTrack })).getAllByRole("button");
    fireEvent.click(lane[2]);
    expect(toggle().disabled).toBe(true);
    expect(clean().textContent).toContain(fmt(cl.stabilizeDoc, { used: 2 * STABILIZE_MAX_S, docMax: STABILIZE_MAX_DOC_S }));
    // a clip that is on can always be turned off
    fireEvent.click(lane[0]);
    expect(toggle().disabled).toBe(false);
  });

  it("a frozen frame and a photo have nothing to steady, and the reason is said", () => {
    mount(videoDoc({ out_s: 4, freeze: true, speed: 1, audio: false }));
    expect(toggle().disabled).toBe(true);
    expect(clean().textContent).toContain(cl.stabilizeFreeze);
    cleanup();
    mount(photoDoc());
    expect(toggle().disabled).toBe(true);
    expect(clean().textContent).toContain(cl.stabilizePhoto);
    expect(within(clean()).queryByRole("checkbox", { name: cl.denoise })).toBeNull();
  });

  it("freezing a steadied clip turns the steadiness off (the document refuses both)", async () => {
    mount(videoDoc({ out_s: 4, stabilize: true }));
    fireEvent.click(check(section(fxe.speed.more), fxe.speed.freeze));
    expect(toggle().checked).toBe(false);
    const doc = await save();
    expect(clip0(doc).stabilize).toBeUndefined();
    expect(validateTimeline(doc)).toEqual([]);
  });

  it("trimming a steadied clip stops at the per-clip range", () => {
    mount(longDoc(100));
    fireEvent.click(toggle());
    const out = screen.getByRole("spinbutton", { name: te.trimOut });
    fireEvent.change(out, { target: { value: "300" } });
    fireEvent.keyDown(out, { key: "Enter" });
    expect((screen.getByRole("spinbutton", { name: te.trimOut }) as HTMLInputElement).value).toBe(String(STABILIZE_MAX_S));
  });

  it("is carried by the local draft", () => {
    vi.useFakeTimers();
    mount(videoDoc());
    fireEvent.click(toggle());
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS + 50);
    expect(clip0(readDraft("user-1", PID, 1)!.doc).stabilize).toBe(true);
  });
});

describe("words", () => {
  const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
  it("ru and uz render the new sections in their language", () => {
    for (const [loc, d] of [["ru", ru], ["uz", uz]] as const) {
      mount(videoDoc(), loc);
      expect(screen.getByText(d.editor.fx.clean.title)).toBeTruthy();
      cleanup();
      mount(overlayDoc(P), loc);
      fireEvent.click(screen.getByRole("button", { name: /logo\.png/ }));
      expect(screen.getByText(d.editor.fx.chroma.title)).toBeTruthy();
      cleanup();
    }
  });
  it("every new string has its ru and uz twin with the same placeholders, translated, and no brand names", () => {
    for (const [name, d] of [["ru", ru], ["uz", uz]] as const) {
      for (const group of ["chroma", "clean"] as const) {
        const a = en.editor.fx[group] as Record<string, string>;
        const b = d.editor.fx[group] as Record<string, string>;
        expect(Object.keys(b).sort(), `${name}.${group}`).toEqual(Object.keys(a).sort());
        for (const k of Object.keys(a)) {
          expect(holes(b[k]), `${name}.${group}.${k}`).toBe(holes(a[k]));
          if (a[k].length > 12) expect(b[k], `${name}.${group}.${k}`).not.toBe(a[k]);
        }
        expect(Object.values(b).join(" ")).not.toMatch(/ffmpeg|vidstab|afftdn|loudnorm|chromakey|capcut/i);
      }
    }
    expect(JSON.stringify(uz.editor.fx)).not.toMatch(/[a-z]'[a-z]/i);
  });
  it("the two clean-up toggles use the words the product uses for the sound and the volume", () => {
    expect(ru.editor.fx.clean.soundOff).toContain(ru.editor.sound);
    expect(uz.editor.fx.clean.soundOff).toContain(uz.editor.sound);
    expect(en.editor.fx.clean.soundOff).toContain(en.editor.sound);
    expect(ru.editor.fx.clean.loudnormHint).toContain(ru.editor.soundVolume.replace("Громкость", "Громкости"));
  });
});
