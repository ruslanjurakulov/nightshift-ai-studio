// @vitest-environment jsdom
/**
 * Editor follow-ups to migration 0054: music / sound effects on their own
 * A tracks and a cross-fade between two neighbouring clips.
 *
 * What would break without these: a cross-fade the renderer refuses (longer
 * than a clip, into material the other cross-fade already uses, clips that
 * swap order); a song longer than the video silently making the export
 * longer; a volume or fade outside what the document allows; a picker that
 * offers something other than the library's audio; a sound that cannot be
 * reached, changed or removed from the keyboard. Nothing here renders,
 * spends or publishes: Save sends the document, the worker renders it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";

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
import { previewVolume } from "@/components/editor/SoundPreview";
import {
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  MAX_AUDIO_CLIPS,
  MAX_EDITOR_SOUNDS,
  XFADE_MAX_S,
  XFADE_MIN_S,
  addClip,
  addSound,
  canAddSound,
  crossfadeOf,
  docAssetProblems,
  fitSoundToPicture,
  layout,
  maxCrossfade,
  modelDuration,
  newDocForAsset,
  removeClip,
  setClipAudio,
  setCrossfade,
  setSpeed,
  soundWarnings,
  splitClip,
  toDoc,
  toModel,
  trimClip,
  updateSound,
  validateTimeline,
  type EditorAsset,
  type EditorModel,
  type TimelineDoc,
} from "@/lib/editor";

const te = en.editor;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const MU = "44444444-4444-4444-8444-444444444444";

const VIDEO: EditorAsset = { id: A, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080, viewUrl: "/v/a", thumbUrl: null };
const VIDEO2: EditorAsset = { id: B, kind: "video", name: "city.mp4", durationS: 4, width: 1920, height: 1080, viewUrl: "/v/b", thumbUrl: null };
const SONG: EditorAsset = { id: MU, kind: "audio", name: "song.mp3", durationS: 180, width: null, height: null, viewUrl: "/v/m", thumbUrl: null };

function twoClips(): EditorModel {
  return addClip(toModel(newDocForAsset(VIDEO)!), VIDEO2);
}

const valid = (m: EditorModel) => validateTimeline(toDoc(m));

describe("cross-fade in the model", () => {
  it("overlaps the two clips by its length and the document is valid", () => {
    const m = setCrossfade(twoClips(), "c2", 1);
    const [c1, c2] = layout(m.clips);
    expect(crossfadeOf(c2)).toBe(1);
    expect(c2.start_s).toBe(9);           // 10 s clip, 1 s cross-fade
    expect(c1.start_s).toBe(0);
    expect(modelDuration(m)).toBe(13);    // 10 + 4 - 1
    expect(valid(m)).toEqual([]);
    expect(toDoc(m).tracks[0].clips[1].transition).toEqual({ type: "crossfade", duration_s: 1 });
  });

  it("is bounded 0.2-2 s and by the material both clips have", () => {
    expect([XFADE_MIN_S, XFADE_MAX_S]).toEqual([0.2, 2]);
    let m = setCrossfade(twoClips(), "c2", 5);
    expect(crossfadeOf(layout(m.clips)[1])).toBe(2);
    m = setCrossfade(twoClips(), "c2", 0.05);
    expect(crossfadeOf(layout(m.clips)[1])).toBe(0.2);
    // The second clip trimmed to 0.5 s: the cross-fade can only be shorter.
    m = trimClip(setCrossfade(twoClips(), "c2", 2), "c2", "out", 0.5, 4);
    const x = crossfadeOf(layout(m.clips)[1]);
    expect(x).toBeLessThanOrEqual(0.5);
    expect(x).toBeGreaterThanOrEqual(0.2);
    expect(valid(m)).toEqual([]);
  });

  it("cannot be put on the first clip, and a too-short neighbour makes it a cut", () => {
    const m = twoClips();
    expect(maxCrossfade(m, "c1")).toBe(0);
    expect(setCrossfade(m, "c1", 1)).toBe(m);
    // Trimmed below 0.2 s: the cross-fade drops to a cut instead of an invalid document.
    const short = trimClip(setCrossfade(m, "c2", 1), "c2", "out", 0.15, 4);
    expect(crossfadeOf(layout(short.clips)[1])).toBe(0);
    expect(valid(short)).toEqual([]);
  });

  it("two cross-fades never meet inside a clip, whatever the speeds", () => {
    let m = addClip(twoClips(), VIDEO);              // c1 10 s, c2 4 s, c3 10 s
    m = setCrossfade(setCrossfade(m, "c2", 2), "c3", 2);
    expect(maxCrossfade(m, "c3")).toBeLessThanOrEqual(2);
    m = setSpeed(m, "c2", 2);                         // c2 now 2 s on the timeline
    const [, c2, c3] = layout(m.clips);
    expect(crossfadeOf(c2) + crossfadeOf(c3)).toBeLessThanOrEqual(2);
    expect(valid(m)).toEqual([]);
    // Clips stay in order: every start is later than the one before.
    const starts = layout(m.clips).map((c) => c.start_s);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("split, move and delete keep a valid document", () => {
    let m = setCrossfade(twoClips(), "c2", 1);
    const out = splitClip(m, "c2", 11);
    expect(out).not.toBeNull();
    m = out!.model;
    // The second half does not inherit the way in.
    expect(crossfadeOf(layout(m.clips)[2])).toBe(0);
    expect(valid(m)).toEqual([]);
    m = removeClip(m, "c1");
    expect(crossfadeOf(layout(m.clips)[0])).toBe(0);  // nothing before it now
    expect(valid(m)).toEqual([]);
  });

  it("a dip to black from another tool survives a round trip", () => {
    const doc = newDocForAsset(VIDEO)!;
    (doc.tracks[0].clips[0] as Record<string, unknown>).transition = { type: "dip_to_black", duration_s: 0.4 };
    const again = toDoc(toModel(doc));
    expect(again.tracks[0].clips[0].transition).toEqual({ type: "dip_to_black", duration_s: 0.4 });
  });
});

describe("music and sounds in the model", () => {
  it("adds a song at the playhead, no longer than the video has left", () => {
    const m = toModel(newDocForAsset(VIDEO)!);
    const out = addSound(m, SONG, 3)!;
    const s = out.model.sounds[0];
    expect(s).toMatchObject({ asset_id: MU, start_s: 3, in_s: 0, out_s: 7, gain_db: 0 });
    expect(modelDuration(out.model)).toBe(10);       // the export is not longer
    const doc = toDoc(out.model);
    expect(validateTimeline(doc)).toEqual([]);
    const aTracks = doc.tracks.filter((t) => t.kind === "A");
    expect(aTracks).toHaveLength(1);
    expect(aTracks[0].clips[0]).toMatchObject({ id: out.id, gain_db: 0, fade_in_s: 0, fade_out_s: 0 });
    expect(docAssetProblems(doc, { [A]: "video", [MU]: "audio" })).toEqual([]);
    expect(docAssetProblems(doc, { [A]: "video", [MU]: "image" })).not.toEqual([]);
  });

  it("keeps volume and fades inside what the renderer allows", () => {
    let m = addSound(toModel(newDocForAsset(VIDEO)!), SONG, 0)!.model;
    const id = m.sounds[0].id;
    m = updateSound(m, id, { gain_db: 40 }, 180);
    expect(m.sounds[0].gain_db).toBe(GAIN_DB_MAX);
    m = updateSound(m, id, { gain_db: -500 }, 180);
    expect(m.sounds[0].gain_db).toBe(GAIN_DB_MIN);
    m = updateSound(m, id, { fade_in_s: 8 }, 180);
    m = updateSound(m, id, { fade_out_s: 8 }, 180);  // 10 s long: the last change wins
    expect(m.sounds[0].fade_out_s).toBe(8);
    expect(m.sounds[0].fade_in_s).toBe(2);
    m = updateSound(m, id, { out_s: 500 }, 180);      // past the file's end
    expect(m.sounds[0].out_s).toBe(180);
    m = updateSound(m, id, { out_s: 1 }, 180);        // shorter than its fades
    expect(m.sounds[0].fade_in_s + m.sounds[0].fade_out_s).toBeLessThanOrEqual(1);
    expect(valid(m)).toEqual([]);
  });

  it("warns when a sound runs past the video and can end it with the video", () => {
    let m = addSound(toModel(newDocForAsset(VIDEO)!), SONG, 0)!.model;
    const id = m.sounds[0].id;
    m = updateSound(m, id, { out_s: 30 }, 180);
    expect(soundWarnings(m)).toEqual({ [id]: "past_end" });
    expect(modelDuration(m)).toBe(30);
    m = fitSoundToPicture(m, id);
    expect(soundWarnings(m)).toEqual({});
    expect(modelDuration(m)).toBe(10);
  });

  it("at most six sounds, and never more than the mix can take", () => {
    let m = toModel(newDocForAsset(VIDEO)!);
    for (let i = 0; i < MAX_EDITOR_SOUNDS; i += 1) m = addSound(m, SONG, 0)!.model;
    expect(canAddSound(m)).toBe(false);
    expect(addSound(m, SONG, 0)).toBeNull();
    expect(toDoc(m).tracks.length).toBeLessThanOrEqual(32);
    expect(valid(m)).toEqual([]);
    // A full mix: clips playing their own sound + sounds = MAX_AUDIO_CLIPS.
    let full = toModel(newDocForAsset(VIDEO)!);
    for (let i = 0; i < 4; i += 1) full = addSound(full, SONG, 0)!.model;
    for (let i = 0; full.clips.length + full.sounds.length < MAX_AUDIO_CLIPS; i += 1) full = addClip(full, VIDEO2);
    expect(canAddSound(full)).toBe(false);
    const extra = addClip(full, VIDEO2);
    expect(extra.clips[extra.clips.length - 1].audio).toBe(false);
    expect(setClipAudio(extra, extra.clips[extra.clips.length - 1].id, true)).toBe(extra);
    expect(valid(extra)).toEqual([]);
  });

  it("old documents with one music track of two clips keep both", () => {
    const doc = newDocForAsset(VIDEO)!;
    doc.tracks.push({ id: "music", kind: "A", name: "music", clips: [
      { id: "m1", asset_id: MU, start_s: 0, in_s: 0, out_s: 3, gain_db: -6 },
      { id: "m2", asset_id: MU, start_s: 4, in_s: 10, out_s: 12 },
    ] });
    const m = toModel(doc);
    expect(m.sounds.map((x) => x.id)).toEqual(["m1", "m2"]);
    expect(validateTimeline(toDoc(m))).toEqual([]);
  });
});

describe("the preview's volume", () => {
  it("is the gain as a 0..1 level, never louder than the file", () => {
    expect(previewVolume(0)).toBe(1);
    expect(previewVolume(6)).toBe(1);
    expect(previewVolume(-20)).toBeCloseTo(0.1, 5);
    expect(previewVolume(-60)).toBeCloseTo(0.001, 5);
  });
});

describe("every new sentence exists in en, ru and uz", () => {
  const keys = ["soundsTrack", "addSound", "addSoundTitle", "noSounds", "soundHeading", "soundVolume",
    "soundFadeIn", "soundFadeOut", "soundPastEnd", "soundFit", "maxSounds", "audioFull", "transition",
    "cut", "crossfade", "crossfadeLength", "crossfadeHint", "crossfadeFirst", "crossfadeTooShort",
    "clipCrossfade", "soundClipLabel", "soundToPlayhead", "deleteSound"] as const;
  it.each([["ru", ru], ["uz", uz]] as const)("%s", (_n, dict) => {
    for (const k of keys) {
      expect(typeof dict.editor[k]).toBe("string");
      expect(dict.editor[k]).not.toBe(en.editor[k]);
    }
    expect(dict.editor.exportReasons.timed_out).toBeTruthy();
  });
});

// ── the page ────────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function withI18n(ui: ReactNode) {
  return <I18nProvider locale="en">{ui}</I18nProvider>;
}

function mount(doc: TimelineDoc, soundFiles: EditorAsset[] = [SONG]) {
  return render(
    withI18n(
      <TimelineEditor projectId={PID} title="Trip" rev={1} doc={doc} exports={[]}
        assets={{ [A]: VIDEO, [B]: VIDEO2 }} videos={[VIDEO, VIDEO2]} soundFiles={soundFiles} />,
    ),
  );
}

const twoClipDoc = () => toDoc(twoClips());
const putBody = () => {
  const put = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "PUT")!;
  return JSON.parse(String((put[1] as RequestInit).body));
};

describe("the editor page", () => {
  it("adds music from the library's audio, changes it from the keyboard, and saves it on an A track", async () => {
    mount(twoClipDoc());
    fireEvent.click(screen.getByRole("button", { name: te.addSound }));
    const picker = screen.getByRole("region", { name: te.addSoundTitle });
    // Only audio is offered.
    expect(within(picker).queryByRole("button", { name: /beach|city/ })).toBeNull();
    expect(within(picker).getByRole("button", { name: /song\.mp3/ }).textContent).toContain("3:00.0");
    fireEvent.click(within(picker).getByRole("button", { name: /song\.mp3/ }));
    const lane = screen.getByRole("list", { name: te.soundsTrack });
    const block = within(lane).getByRole("button");
    expect(block.getAttribute("aria-pressed")).toBe("true");
    expect(block.getAttribute("aria-label")).toBe(fmt(te.soundClipLabel, { name: "song.mp3", from: "0:00.0", to: "0:14.0" }));
    expect(screen.getByRole("heading", { name: te.soundHeading })).toBeTruthy();

    const volume = screen.getByRole("slider", { name: new RegExp(te.soundVolume) });
    fireEvent.change(volume, { target: { value: "-12" } });
    const fadeIn = screen.getByRole("spinbutton", { name: te.soundFadeIn });
    fireEvent.change(fadeIn, { target: { value: "1.5" } });
    fireEvent.keyDown(fadeIn, { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(putBody()).toBeTruthy());
    const doc = putBody().doc as TimelineDoc;
    const a = doc.tracks.filter((t) => t.kind === "A");
    expect(a).toHaveLength(1);
    expect(a[0].clips[0]).toMatchObject({ asset_id: MU, start_s: 0, in_s: 0, out_s: 14, gain_db: -12, fade_in_s: 1.5, fade_out_s: 0 });
    expect(validateTimeline(doc)).toEqual([]);
    // Saving never asked for a render.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/exports"))).toBe(false);
  });

  it("says when the library has no audio and links to it", () => {
    mount(twoClipDoc(), []);
    fireEvent.click(screen.getByRole("button", { name: te.addSound }));
    expect(screen.getByText(new RegExp(te.noSounds.slice(0, 20)))).toBeTruthy();
    expect(screen.getByRole("link", { name: te.openLibrary })).toBeTruthy();
  });

  it("warns about a sound past the end of the video and fixes it in one press", () => {
    const m = updateSound(addSound(twoClips(), SONG, 0)!.model, "m3", { out_s: 60 }, 180);
    mount(toDoc(m));
    fireEvent.click(within(screen.getByRole("list", { name: te.soundsTrack })).getByRole("button"));
    expect(screen.getByText(te.soundPastEnd)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: te.soundFit }));
    expect(screen.queryByText(te.soundPastEnd)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: te.deleteSound }));
    expect(screen.queryByRole("list", { name: te.soundsTrack })).toBeNull();
  });

  it("cross-fades the second clip into the first from the inspector", async () => {
    mount(twoClipDoc());
    const clips = () => within(screen.getByRole("list", { name: te.clipsTrack })).getAllByRole("button");
    // The first clip has nothing to cross-fade from.
    expect(screen.getByText(te.crossfadeFirst)).toBeTruthy();
    expect(screen.getByRole("radio", { name: te.crossfade })).toHaveProperty("disabled", true);
    fireEvent.click(clips()[1]);
    fireEvent.click(screen.getByRole("radio", { name: te.crossfade }));
    expect(clips()[1].getAttribute("aria-label")).toContain(fmt(te.clipCrossfade, { s: 0.5 }));
    const len = screen.getByRole("spinbutton", { name: te.crossfadeLength });
    fireEvent.change(len, { target: { value: "9" } });
    fireEvent.keyDown(len, { key: "Enter" });
    expect(clips()[1].getAttribute("aria-label")).toContain(fmt(te.clipCrossfade, { s: 2 }));
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(putBody()).toBeTruthy());
    const doc = putBody().doc as TimelineDoc;
    expect(doc.tracks[0].clips[1]).toMatchObject({ start_s: 8, transition: { type: "crossfade", duration_s: 2 } });
    expect(validateTimeline(doc)).toEqual([]);
    // Back to a cut.
    fireEvent.click(screen.getByRole("radio", { name: te.cut }));
    expect(clips()[1].getAttribute("aria-label")).not.toContain(fmt(te.clipCrossfade, { s: 2 }));
  });
});
