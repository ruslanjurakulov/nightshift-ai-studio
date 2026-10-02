// @vitest-environment jsdom
/**
 * Editor: waveform on sounds and music ducking (modules/timeline.py DUCK_*).
 *
 * What would break without these: a ducking document the worker refuses (a
 * speech track that is also ducked, an amount or ramp outside the range), an
 * old document losing its music when opened and saved, a waveform that reads
 * as silence when it merely could not be drawn, a preview that ducks when the
 * export would not (or the other way round), and a control a keyboard cannot
 * reach. Nothing here renders, spends or publishes: Save sends the document.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  DUCK_DEFAULT,
    addSound,
  clampDuck,
  duckGainAt,
  hasSpeech,
  mergeSpans,
  newDocForAsset,
  setClipAudio,
  speechSpans,
  toDoc,
  toModel,
  updateSound,
  validateTimeline,
  type EditorAsset,
  type EditorModel,
  type TimelineDoc,
} from "@/lib/editor";
import {
  MAX_BUCKETS,
  PEAKS_PER_SECOND,
  barsFor,
  barsPath,
  bucketCount,
  clearPeaksCache,
  computePeaks,
  loadPeaks,
  peaksFor,
} from "@/lib/waveform";

const te = en.editor;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const MU = "44444444-4444-4444-8444-444444444444";
const VO = "55555555-5555-4555-8555-555555555555";

const VIDEO: EditorAsset = { id: A, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080, viewUrl: "/v/a", thumbUrl: null };
const SONG: EditorAsset = { id: MU, kind: "audio", name: "song.mp3", durationS: 180, width: null, height: null, viewUrl: "/v/m", thumbUrl: null };
const VOICE: EditorAsset = { id: VO, kind: "audio", name: "voice.mp3", durationS: 6, width: null, height: null, viewUrl: "/v/v", thumbUrl: null };

const valid = (m: EditorModel) => validateTimeline(toDoc(m));
/** One 10 s picture whose own sound is OFF (a new project plays it, which is
 *  speech as far as ducking goes). */
const base = () => {
  const m = toModel(newDocForAsset(VIDEO)!);
  return setClipAudio(m, m.clips[0].id, false);
};

/** A model: one 10 s picture, a song and a voice-over at 2..6 s. */
function withMusicAndVoice(): { model: EditorModel; music: string; voice: string } {
  const a = addSound(base(), SONG, 0)!;
  const b = addSound(a.model, VOICE, 2)!;
  const m = updateSound(b.model, b.id, { role: "speech", out_s: 4 }, 6);
  return { model: m, music: a.id, voice: b.id };
}

describe("waveform peaks", () => {
  it("takes the loudest sample of each bucket, over every channel", () => {
    const left = new Float32Array([0.1, -0.5, 0.2, 0.0]);
    const right = new Float32Array([0.0, 0.0, -0.9, 0.3]);
    expect(Array.from(computePeaks([left, right], 2))).toEqual([
      Math.fround(0.5), Math.fround(0.9),
    ]);
  });

  it("never exceeds 1 and gives silence for empty audio, not a guess", () => {
    expect(computePeaks([new Float32Array([3, -2])], 1)[0]).toBe(1);
    expect(Array.from(computePeaks([], 3))).toEqual([0, 0, 0]);
  });

  it("buckets are bounded", () => {
    expect(bucketCount(2)).toBe(2 * PEAKS_PER_SECOND);
    expect(bucketCount(10 * 3600)).toBe(MAX_BUCKETS);
    expect(bucketCount(0)).toBe(1);
    expect(bucketCount(Number.NaN)).toBe(1);
  });

  it("draws only the part of the file a clip uses", () => {
    // 10 s at 1 bucket/s: quiet first half, loud second half.
    const peaks = new Float32Array([0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
    expect(barsFor(peaks, 10, 0, 5, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(barsFor(peaks, 10, 5, 10, 5)).toEqual([1, 1, 1, 1, 1]);
    // A range past the file is clamped to it; an empty range has no bars.
    expect(barsFor(peaks, 10, 8, 99, 2)).toEqual([1, 1]);
    expect(barsFor(peaks, 10, 6, 6, 4)).toEqual([]);
    expect(barsFor(peaks, 0, 0, 1, 4)).toEqual([]);
  });

  it("a path has one bar per height and a hairline for a silent bar", () => {
    const d = barsPath([0, 1]);
    expect(d.split("M").length - 1).toBe(2);
    expect(d).toContain("M0 49.00h0.7v2.00h-0.7z");
    expect(d).toContain("M1 0.00h0.7v100.00h-0.7z");
  });
});

describe("loading peaks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearPeaksCache();
  });
  const decoded = (duration: number, channels = 1) => ({
    duration,
    numberOfChannels: channels,
    getChannelData: () => new Float32Array([0, 0.5, -1, 0.25]),
  });
  function stub(decode: () => Promise<unknown>, init: { ok?: boolean; length?: string; bytes?: number } = {}) {
    class Ctx { decodeAudioData = decode; }
    vi.stubGlobal("OfflineAudioContext", Ctx);
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: init.ok ?? true,
      headers: { get: () => init.length ?? null },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(init.bytes ?? 8)),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("is ready with the file's real peaks", async () => {
    stub(() => Promise.resolve(decoded(2)));
    const r = await loadPeaks("/v/m", 2);
    expect(r.status).toBe("ready");
    if (r.status === "ready") {
      expect(r.durationS).toBe(2);
      expect(Math.max(...r.peaks)).toBe(1);
    }
  });

  it("says too_large before downloading when the library knows the file is long", async () => {
    const f = stub(() => Promise.resolve(decoded(2)));
    expect(await loadPeaks("/v/m", 3 * 3600)).toEqual({ status: "too_large" });
    expect(f).not.toHaveBeenCalled();
  });

  it("says too_large from the size the server reports", async () => {
    stub(() => Promise.resolve(decoded(2)), { length: String(200 * 1024 * 1024) });
    expect(await loadPeaks("/v/m", null)).toEqual({ status: "too_large" });
  });

  it("names a refused link, an undecodable file and a missing decoder as unavailable", async () => {
    stub(() => Promise.resolve(decoded(2)), { ok: false });
    expect(await loadPeaks("/v/m", 2)).toEqual({ status: "unavailable" });
    stub(() => Promise.reject(new Error("bad data")));
    expect(await loadPeaks("/v/m", 2)).toEqual({ status: "unavailable" });
    vi.stubGlobal("OfflineAudioContext", undefined);
    vi.stubGlobal("webkitOfflineAudioContext", undefined);
    expect(await loadPeaks("/v/m", 2)).toEqual({ status: "unavailable" });
  });

  it("reads a file once per page, and forgets a failure so the next try can succeed", async () => {
    const f = stub(() => Promise.resolve(decoded(2)));
    await peaksFor("a1", "/v/m", 2);
    await peaksFor("a1", "/v/m", 2);
    expect(f).toHaveBeenCalledTimes(1);
    clearPeaksCache();
    stub(() => Promise.reject(new Error("x")));
    expect((await peaksFor("a2", "/v/x", 2)).status).toBe("unavailable");
    const g = stub(() => Promise.resolve(decoded(2)));
    expect((await peaksFor("a2", "/v/x", 2)).status).toBe("ready");
    expect(g).toHaveBeenCalledTimes(1);
  });
});

describe("ducking in the model", () => {
  it("a duck is stored on the sound's own A track with the document's names", () => {
    const { model, music } = withMusicAndVoice();
    const m = updateSound(model, music, { duck: { amount_db: 14, attack_s: 0.2, release_s: 1 } }, 180);
    const doc = toDoc(m);
    const tracks = doc.tracks.filter((t) => t.kind === "A");
    expect(tracks.map((t) => [t.role, t.duck])).toEqual([
      [undefined, { amount_db: 14, attack_s: 0.2, release_s: 1 }],
      ["speech", undefined],
    ]);
    expect(validateTimeline(doc)).toEqual([]);
  });

  it("survives a round trip through the document", () => {
    const { model, music } = withMusicAndVoice();
    const m = updateSound(model, music, { duck: DUCK_DEFAULT }, 180);
    const back = toModel(toDoc(m));
    expect(back.sounds.map((x) => [x.role, x.duck])).toEqual([[undefined, DUCK_DEFAULT], ["speech", undefined]]);
    expect(JSON.stringify(toDoc(back))).toBe(JSON.stringify(toDoc(m)));
  });

  it("fills the defaults a document may leave out", () => {
    const doc = toDoc(withMusicAndVoice().model);
    const track = doc.tracks.find((t) => t.kind === "A" && !t.role)!;
    track.duck = { amount_db: 9 } as never;
    const m = toModel(doc);
    expect(m.sounds[0].duck).toEqual({ amount_db: 9, attack_s: 0.3, release_s: 0.8 });
  });

  it("keeps a duck inside the range a document accepts", () => {
    expect(clampDuck({ amount_db: 99, attack_s: 0, release_s: 99 })).toEqual({ amount_db: 40, attack_s: 0.05, release_s: 5 });
    expect(clampDuck({ amount_db: 0, attack_s: 9, release_s: 0 })).toEqual({ amount_db: 1, attack_s: 2, release_s: 0.1 });
    const { model, music } = withMusicAndVoice();
    const m = updateSound(model, music, { duck: { amount_db: 500, attack_s: 0.3, release_s: 0.8 } }, 180);
    expect(m.sounds[0].duck!.amount_db).toBe(40);
    expect(valid(m)).toEqual([]);
  });

  it("a speech sound can never be ducked, and turning ducking off removes it", () => {
    const { model, music } = withMusicAndVoice();
    const ducked = updateSound(model, music, { duck: DUCK_DEFAULT }, 180);
    const asSpeech = updateSound(ducked, music, { role: "speech" }, 180);
    expect(asSpeech.sounds[0].duck).toBeUndefined();
    expect(valid(asSpeech)).toEqual([]);
    const off = updateSound(ducked, music, { duck: undefined }, 180);
    expect("duck" in off.sounds[0]).toBe(false);
    const music2 = updateSound(asSpeech, music, { role: undefined }, 180);
    expect("role" in music2.sounds[0]).toBe(false);
  });

  it("the validator refuses what the worker refuses", () => {
    const doc = toDoc(updateSound(withMusicAndVoice().model, withMusicAndVoice().music, { duck: DUCK_DEFAULT }, 180));
    const bad = (mut: (t: NonNullable<TimelineDoc["tracks"][number]>) => void) => {
      const d = JSON.parse(JSON.stringify(doc)) as TimelineDoc;
      mut(d.tracks.find((t) => t.kind === "A" && t.duck)!);
      return validateTimeline(d);
    };
    expect(bad((t) => { t.duck!.amount_db = 0.5; }).join()).toMatch(/amount_db/);
    expect(bad((t) => { t.duck!.amount_db = 41; }).join()).toMatch(/amount_db/);
    expect(bad((t) => { t.duck!.attack_s = 0.01; }).join()).toMatch(/attack_s/);
    expect(bad((t) => { t.duck!.release_s = 6; }).join()).toMatch(/release_s/);
    expect(bad((t) => { (t.duck as unknown as Record<string, unknown>).curve = "log"; }).join()).toMatch(/curve/);
    expect(bad((t) => { delete (t.duck as unknown as Record<string, unknown>).amount_db; }).join()).toMatch(/amount_db/);
    expect(bad((t) => { t.role = "speech"; }).join()).toMatch(/speech track cannot be lowered/);
    expect(bad((t) => { (t as { role?: string }).role = "narrator"; }).join()).toMatch(/role must be/);
    // role / duck belong to sound tracks only.
    const d = JSON.parse(JSON.stringify(toDoc(base()))) as TimelineDoc;
    (d.tracks[0] as unknown as Record<string, unknown>).duck = { amount_db: 6 };
    expect(validateTimeline(d).join()).toMatch(/duck/);
  });

  it("a document from before ducking opens and saves unchanged", () => {
    const m = addSound(base(), SONG, 0)!.model;
    const doc = toDoc(m);
    expect(doc.tracks.find((t) => t.kind === "A")).not.toHaveProperty("duck");
    expect(doc.tracks.find((t) => t.kind === "A")).not.toHaveProperty("role");
    expect(JSON.stringify(toDoc(toModel(doc)))).toBe(JSON.stringify(doc));
  });
});

describe("speech and the envelope", () => {
  it("speech is every speech sound and every picture clip that plays its own sound", () => {
    const { model } = withMusicAndVoice();
    expect(speechSpans(model)).toEqual([[2, 6]]);
    expect(hasSpeech(model)).toBe(true);
    const noVoice = addSound(base(), SONG, 0)!.model;
    expect(hasSpeech(noVoice)).toBe(false);
    const own = setClipAudio(noVoice, noVoice.clips[0].id, true);
    expect(speechSpans(own)).toEqual([[0, 10]]);
    // Without a voice and with the picture's sound off, nothing is speech.
    expect(speechSpans(noVoice)).toEqual([]);
  });

  it("merges spans separated by a pause too short for the music to come back", () => {
    expect(mergeSpans([[0, 1], [1.5, 2], [10, 11]], 1)).toEqual([[0, 2], [10, 11]]);
    expect(mergeSpans([[5, 6], [0, 1]], 0.1)).toEqual([[0, 1], [5, 6]]);
  });

  it("is 1 away from speech, exactly -amount inside it and ramped between", () => {
    const duck = { amount_db: 12, attack_s: 1, release_s: 2 };
    const speech: [number, number][] = [[10, 20]];
    const floor = 10 ** (-12 / 20);
    expect(duckGainAt(duck, speech, 0)).toBe(1);
    expect(duckGainAt(duck, speech, 9)).toBeCloseTo(1, 10);
    expect(duckGainAt(duck, speech, 15)).toBeCloseTo(floor, 10);
    expect(duckGainAt(duck, speech, 10)).toBeCloseTo(floor, 10);
    expect(duckGainAt(duck, speech, 9.5)).toBeCloseTo(1 - (1 - floor) / 2, 10);
    expect(duckGainAt(duck, speech, 21)).toBeCloseTo(1 - (1 - floor) / 2, 10);
    expect(duckGainAt(duck, speech, 22)).toBeCloseTo(1, 10);
    expect(duckGainAt(duck, [], 15)).toBe(1);
  });

  it("the preview volume carries the envelope and still never exceeds the file", () => {
    expect(previewVolume(0, 0.25)).toBeCloseTo(0.25, 10);
    expect(previewVolume(-6, 0.5)).toBeCloseTo(0.5 * 10 ** (-6 / 20), 10);
    expect(previewVolume(6, 1)).toBe(1);
    expect(previewVolume(0)).toBe(1);
  });
});

describe("every new sentence exists in en, ru and uz", () => {
  const keys = ["waveTooLarge", "waveUnavailable", "roleSpeechShort", "duckBadge", "duckLabel", "soundKind",
    "roleMusic", "roleSpeech", "roleMusicHint", "roleSpeechHint", "duckToggle", "duckAmount", "duckAttack",
    "duckRelease", "duckHint", "duckNoSpeech"] as const;
  it.each([["ru", ru], ["uz", uz]] as const)("%s", (_n, dict) => {
    for (const k of keys) {
      expect(typeof dict.editor[k]).toBe("string");
      expect(dict.editor[k]).not.toBe(en.editor[k]);
    }
  });
  it("keeps the placeholders in step", () => {
    for (const k of ["duckBadge", "duckLabel"] as const)
      for (const d of [en, ru, uz]) expect(d.editor[k]).toContain("{db}");
  });
});

// ── the page ────────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearPeaksCache();
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

const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;

function mount(doc: TimelineDoc, soundFiles: EditorAsset[] = [SONG, VOICE]) {
  const assets: Record<string, EditorAsset> = { [A]: VIDEO, [MU]: SONG, [VO]: VOICE };
  return render(
    withI18n(
      <TimelineEditor projectId={PID} title="Trip" rev={1} doc={doc} exports={[]}
        assets={assets} videos={[VIDEO]} soundFiles={soundFiles} />,
    ),
  );
}

const putBody = () => {
  const put = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "PUT")!;
  return JSON.parse(String((put[1] as RequestInit).body));
};

function addFromLibrary(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name: te.addSound }));
  const picker = screen.getByRole("region", { name: te.addSoundTitle });
  fireEvent.click(within(picker).getByRole("button", { name }));
}

describe("the editor page: waveform", () => {
  function decoder(decode: () => Promise<unknown>) {
    class Ctx { decodeAudioData = decode; }
    vi.stubGlobal("OfflineAudioContext", Ctx);
    fetchMock.mockImplementation(() => Promise.resolve({
      ok: true, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    }));
  }

  it("draws the waveform of a sound on the timeline", async () => {
    decoder(() => Promise.resolve({ duration: 180, numberOfChannels: 1, getChannelData: () => new Float32Array([0.2, 0.8, 0.4]) }));
    mount(toDoc(base()));
    addFromLibrary(/song\.mp3/);
    const lane = screen.getByRole("list", { name: te.soundsTrack });
    await waitFor(() => expect(within(lane).getByTestId("sound-wave")).toBeTruthy());
    expect(within(lane).getByTestId("sound-wave").getAttribute("aria-hidden")).toBe("true");
    expect(within(lane).getByTestId("sound-wave").querySelector("path")!.getAttribute("d")).toMatch(/^M0 /);
  });

  it("says so when it cannot draw one, instead of drawing silence", async () => {
    decoder(() => Promise.reject(new Error("cannot decode")));
    mount(toDoc(base()));
    addFromLibrary(/song\.mp3/);
    const lane = screen.getByRole("list", { name: te.soundsTrack });
    await waitFor(() => expect(within(lane).getByText(te.waveUnavailable)).toBeTruthy());
    expect(within(lane).queryByTestId("sound-wave")).toBeNull();
  });

  it("says when the file is too large for a tab", async () => {
    decoder(() => Promise.resolve({ duration: 1, numberOfChannels: 1, getChannelData: () => new Float32Array(1) }));
    const huge: EditorAsset = { ...SONG, durationS: 3 * 3600 };
    const doc = toDoc(base());
    doc.tracks.push({ id: "a1", kind: "A", clips: [{ id: "m1", asset_id: MU, start_s: 0, in_s: 0, out_s: 5 }] });
    render(withI18n(
      <TimelineEditor projectId={PID} title="Trip" rev={1} doc={doc} exports={[]}
        assets={{ [A]: VIDEO, [MU]: huge }} videos={[VIDEO]} soundFiles={[huge]} />,
    ));
    const lane = screen.getByRole("list", { name: te.soundsTrack });
    await waitFor(() => expect(within(lane).getByText(te.waveTooLarge)).toBeTruthy());
  });
});

describe("the editor page: ducking", () => {
  it("marks a sound as speech and ducks the music from the keyboard-reachable controls, and saves it", async () => {
    mount(toDoc(base()));
    addFromLibrary(/voice\.mp3/);
    // A new sound is music: the speech hint is not shown, the duck controls are.
    const kind = screen.getByRole("group", { name: te.soundKind });
    expect(within(kind).getByRole("button", { name: te.roleMusic }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(kind).getByRole("button", { name: te.roleSpeech }));
    expect(screen.queryByRole("checkbox", { name: te.duckToggle })).toBeNull();
    expect(screen.getByText(te.roleSpeechHint)).toBeTruthy();

    addFromLibrary(/song\.mp3/);
    // Ducking is off until asked for, and warns when there is nothing to duck under... here there is speech.
    const toggle = screen.getByRole("checkbox", { name: te.duckToggle }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(screen.getByText(te.duckHint)).toBeTruthy();
    const amount = screen.getByRole("slider", { name: new RegExp(te.duckAmount) });
    expect(amount.getAttribute("aria-valuetext")).toBe(fmt(te.soundVolumeValue, { db: -12 }));
    fireEvent.change(amount, { target: { value: "18" } });
    const attack = screen.getByRole("spinbutton", { name: te.duckAttack });
    fireEvent.change(attack, { target: { value: "0.5" } });
    fireEvent.keyDown(attack, { key: "Enter" });
    const release = screen.getByRole("spinbutton", { name: te.duckRelease });
    fireEvent.change(release, { target: { value: "1.5" } });
    fireEvent.keyDown(release, { key: "Enter" });

    // The strip says which sound is ducked and which is speech.
    const lane = screen.getByRole("list", { name: te.soundsTrack });
    const labels = within(lane).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(labels.some((l) => l?.includes(te.roleSpeechShort))).toBe(true);
    expect(labels.some((l) => l?.includes(fmt(te.duckLabel, { db: 18 })))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(putBody()).toBeTruthy());
    const doc = putBody().doc as TimelineDoc;
    const a = doc.tracks.filter((t) => t.kind === "A");
    expect(a.map((t) => [t.role, t.duck])).toEqual([
      ["speech", undefined],
      [undefined, { amount_db: 18, attack_s: 0.5, release_s: 1.5 }],
    ]);
    expect(validateTimeline(doc)).toEqual([]);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/exports"))).toBe(false);
  });

  it("tells the person when there is no speech to lower the music under", () => {
    mount(toDoc(base()));
    addFromLibrary(/song\.mp3/);
    fireEvent.click(screen.getByRole("checkbox", { name: te.duckToggle }));
    expect(screen.getByRole("status").textContent).toContain(te.duckNoSpeech);
    expect(screen.queryByText(te.duckHint)).toBeNull();
  });

  it("opens a saved ducked document with the settings in place", () => {
    const { model, music } = withMusicAndVoice();
    const m = updateSound(model, music, { duck: { amount_db: 20, attack_s: 0.4, release_s: 2 } }, 180);
    mount(toDoc(m));
    fireEvent.click(within(screen.getByRole("list", { name: te.soundsTrack })).getAllByRole("button")[0]);
    expect((screen.getByRole("checkbox", { name: te.duckToggle }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("spinbutton", { name: te.duckAttack }) as HTMLInputElement).value).toBe("0.4");
    expect((screen.getByRole("spinbutton", { name: te.duckRelease }) as HTMLInputElement).value).toBe("2");
  });

  it("the preview lowers a ducked sound while speech plays", () => {
    const { model, music } = withMusicAndVoice();
    const m = updateSound(model, music, { duck: { amount_db: 20, attack_s: 0.3, release_s: 0.8 } }, 180);
    mount(toDoc(m));
    const audios = Array.from(document.querySelectorAll("audio")) as HTMLAudioElement[];
    expect(audios).toHaveLength(2);
    const musicAudio = audios.find((a) => a.getAttribute("src") === "/v/m")!;
    const seek = (s: number) => fireEvent.change(screen.getByRole("slider", { name: te.playhead }), { target: { value: String(s) } });
    // Far from the speech (2-6 s) the music is at its own level...
    seek(9);
    fireEvent.click(screen.getByRole("button", { name: te.play }));
    expect(musicAudio.volume).toBe(1);
    // ...inside it, 20 dB lower (0.1)...
    fireEvent.click(screen.getByRole("button", { name: te.pause }));
    seek(4);
    fireEvent.click(screen.getByRole("button", { name: te.play }));
    expect(musicAudio.volume).toBeCloseTo(0.1, 5);
    // ...and half way down the attack ramp, half way there.
    fireEvent.click(screen.getByRole("button", { name: te.pause }));
    seek(1.85);
    fireEvent.click(screen.getByRole("button", { name: te.play }));
    expect(musicAudio.volume).toBeCloseTo(0.55, 1);
  });
});
