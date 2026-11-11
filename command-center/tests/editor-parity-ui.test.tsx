// @vitest-environment jsdom
/**
 * Editor parity, first pass (UI half): the clip inspector's volume (0-200 %) and "Detach audio", the
 * duplicate / copy / paste buttons and keys, and the wider speed keys. What would break without these:
 * a slider that writes what the validator refuses or makes one undo step per pixel, a detach that
 * leaves the clip sounding twice, a button that is on when it can do nothing (and says nothing), a
 * paste that keeps the original's id, Ctrl+C stolen from a text field, or a sentence missing in a
 * language. No network but the editor's own save.
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
import { SoundWave } from "@/components/editor/SoundWave";
import { MAX_WAVEFORM_BYTES, loadPeaks } from "@/lib/waveform";
import {
  CLIP_GAIN_DB_MAX,
  SPEEDS,
  newDocForAsset,
  validateTimeline,
  volumePctToDb,
  type EditorAsset,
  type TimelineDoc,
} from "@/lib/editor";

const te = en.editor;
const ct = te.clipTools;
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

function mount(doc: TimelineDoc, locale: "en" | "ru" | "uz" = "en") {
  return render(
    <I18nProvider locale={locale}>
      <TimelineEditor projectId={PID} title="Trip" rev={1} doc={doc} exports={[]}
        assets={{ [A]: VIDEO, [P]: PHOTO }} videos={[VIDEO]} imageFiles={[PHOTO]} userId="user-1" />
    </I18nProvider>,
  );
}
const videoDoc = (clip: Record<string, unknown> = {}): TimelineDoc => {
  const d = newDocForAsset(VIDEO)!;
  Object.assign(d.tracks[0].clips[0], { audio: true, ...clip });
  return d;
};
const save = async () => {
  fireEvent.click(screen.getByRole("button", { name: te.save }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === "PUT")).toBe(true));
  const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!;
  return JSON.parse(String((put[1] as RequestInit).body)).doc as TimelineDoc;
};
const undo = () => fireEvent.click(screen.getByRole("button", { name: te.undo }));
const volume = () => screen.getByRole("slider", { name: new RegExp(`^${ct.volume.label}`) }) as HTMLInputElement;
const vclips = (d: TimelineDoc) => d.tracks.find((t) => t.kind === "V")!.clips as Record<string, unknown>[];

describe("a clip's own volume", () => {
  it("is a 0-200 % slider under the clip's sound switch, a drag is one undo step, and Save carries gain_db", async () => {
    mount(videoDoc());
    const s = volume();
    expect([s.min, s.max, s.value]).toEqual(["0", "200", "100"]);
    expect(s.getAttribute("aria-valuetext")).toBe(fmt(ct.volume.value, { pct: 100 }));
    expect(document.getElementById(s.getAttribute("aria-describedby")!)!.textContent).toBe(ct.volume.hint);
    for (const v of [120, 160, 200]) fireEvent.change(s, { target: { value: String(v) } });
    expect(volume().value).toBe("200");
    undo();
    expect(volume().value).toBe("100");
    fireEvent.change(volume(), { target: { value: "200" } });
    const doc = await save();
    expect(vclips(doc)[0].gain_db).toBe(CLIP_GAIN_DB_MAX);
    expect(validateTimeline(doc)).toEqual([]);
  });

  it("0 % is the floor (silent), and the slider goes away when the clip's sound is off", () => {
    mount(videoDoc());
    fireEvent.change(volume(), { target: { value: "0" } });
    expect(volume().getAttribute("aria-valuetext")).toBe(fmt(ct.volume.value, { pct: 0 }));
    fireEvent.click(screen.getByRole("checkbox", { name: te.sound }));
    expect(screen.queryByRole("slider", { name: new RegExp(`^${ct.volume.label}`) })).toBeNull();
    expect(screen.queryByRole("button", { name: ct.detach.button })).toBeNull();
  });

  it("reads a saved level back as its percent", () => {
    mount(videoDoc({ gain_db: volumePctToDb(50) }));
    expect(volume().value).toBe("50");
  });
});

describe("detach audio", () => {
  it("makes the clip silent and its sound a sound of its own, selected; Undo puts it back", async () => {
    mount(videoDoc({ in_s: 1, out_s: 7 }));
    fireEvent.click(screen.getByRole("button", { name: ct.detach.button }));
    // the sound's own inspector is now open
    expect(screen.getByRole("heading", { name: te.soundHeading })).toBeTruthy();
    const doc = await save();
    expect(vclips(doc)[0].audio).toBe(false);
    const a = doc.tracks.filter((t) => t.kind === "A");
    expect(a).toHaveLength(1);
    expect(a[0].role).toBe("speech");
    expect(a[0].clips[0]).toMatchObject({ asset_id: A, start_s: 0, in_s: 1, out_s: 7 });
    expect(validateTimeline(doc)).toEqual([]);
    // one Undo returns the clip's own sound and takes the separate one away
    undo();
    expect(screen.queryByRole("heading", { name: te.soundHeading })).toBeNull();
    expect(screen.queryByText(te.untitledSound)).toBeNull();
  });

  it("is said to be unavailable, with the reason, on a sped-up clip", () => {
    mount(videoDoc({ speed: 2 }));
    const b = screen.getByRole("button", { name: ct.detach.button });
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(b.getAttribute("aria-describedby")!)!.textContent).toBe(ct.detach.retimed);
    fireEvent.click(b);
    expect(screen.queryByRole("heading", { name: te.soundHeading })).toBeNull();
  });
});

describe("duplicate, copy and paste", () => {
  const group = () => screen.getByRole("group", { name: ct.clipboard.group });
  it("Duplicate adds the same clip after it and selects the copy; Save has two clips with different ids", async () => {
    mount(videoDoc({ out_s: 4 }));
    fireEvent.click(within(group()).getByRole("button", { name: ct.clipboard.duplicate }));
    expect(screen.getByRole("heading", { name: fmt(te.clipHeading, { n: 2 }) })).toBeTruthy();
    const doc = await save();
    const clips = vclips(doc);
    expect(clips).toHaveLength(2);
    expect(clips[0].id).not.toBe(clips[1].id);
    expect([clips[1].start_s, clips[1].in_s, clips[1].out_s]).toEqual([4, 0, 4]);
  });

  it("Paste is off until something is copied, then puts the copy after the selected clip", () => {
    mount(videoDoc({ out_s: 3 }));
    const paste = () => within(group()).getByRole("button", { name: ct.clipboard.paste });
    expect(paste().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(paste());
    expect(screen.queryByRole("heading", { name: fmt(te.clipHeading, { n: 2 }) })).toBeNull();
    fireEvent.click(within(group()).getByRole("button", { name: ct.clipboard.copy }));
    expect(screen.getByText(ct.clipboard.copied)).toBeTruthy();
    expect(paste().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(paste());
    // the copy is the selection now: its inspector is the one on screen
    expect(screen.getByRole("heading", { name: fmt(te.clipHeading, { n: 2 }) })).toBeTruthy();
  });

  it("Ctrl+D and Ctrl+C / Ctrl+V work on the selected clip, but never while typing in a field", async () => {
    mount(videoDoc({ out_s: 2 }));
    fireEvent.keyDown(document.body, { key: "d", ctrlKey: true });
    expect(screen.getByRole("heading", { name: fmt(te.clipHeading, { n: 2 }) })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "c", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "v", ctrlKey: true });
    expect(screen.getByRole("heading", { name: fmt(te.clipHeading, { n: 3 }) })).toBeTruthy();
    const field = screen.getByRole("textbox", { name: te.projectTitle }) as HTMLInputElement;
    field.focus();
    fireEvent.keyDown(field, { key: "v", ctrlKey: true });
    fireEvent.keyDown(field, { key: "d", ctrlKey: true });
    expect(vclips(await save())).toHaveLength(3);
  });
});

describe("speed keys", () => {
  it("offer 0.1x to 10x, and 10x is saved", async () => {
    mount(videoDoc());
    const g = screen.getByTestId("speed-chips");
    const radios = within(g).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => Number(r.value))).toEqual([...SPEEDS]);
    expect([SPEEDS[0], SPEEDS[SPEEDS.length - 1]]).toEqual([0.1, 10]);
    fireEvent.click(within(g).getByRole("radio", { name: fmt(te.speedValue, { x: 10 }) }));
    const doc = await save();
    expect(vclips(doc)[0].speed).toBe(10);
    expect(validateTimeline(doc)).toEqual([]);
  });
});

describe("the wave of a detached sound", () => {
  it("is not read from a video (no download), and a word says so instead of a flat line", () => {
    render(
      <I18nProvider locale="en">
        <SoundWave sound={{ asset_id: A, in_s: 0, out_s: 4 }} asset={VIDEO} />
      </I18nProvider>,
    );
    expect(screen.getByText(ct.waveVideo)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("sound-wave")).toBeNull();
  });

  it("a file sent without a length is cut off at the cap instead of read whole", async () => {
    class Ctx {
      decodeAudioData() {
        return Promise.resolve({ duration: 1, numberOfChannels: 1, getChannelData: () => new Float32Array(10) });
      }
    }
    vi.stubGlobal("OfflineAudioContext", Ctx);
    const chunk = new Uint8Array(4 * 1024 * 1024);
    let sent = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        sent += chunk.byteLength;
        c.enqueue(chunk);
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(body, { status: 200 }))));
    expect(await loadPeaks("/m/huge", null)).toEqual({ status: "too_large" });
    expect(sent).toBeLessThanOrEqual(MAX_WAVEFORM_BYTES + 3 * chunk.byteLength);
    expect(cancel).toHaveBeenCalled();
  });
});

describe("a fast clip on a long timeline", () => {
  it("choosing 10x is slowed to what the export can afford, with the reason on the screen, and saves", async () => {
    const LONG: EditorAsset = { ...VIDEO, durationS: 3000 };
    const doc = newDocForAsset(LONG)!;
    Object.assign(doc.tracks[0].clips[0], { audio: true, out_s: 2000 });
    doc.fps = 60;
    render(
      <I18nProvider locale="en">
        <TimelineEditor projectId={PID} title="Trip" rev={1} doc={doc} exports={[]}
          assets={{ [A]: LONG }} videos={[LONG]} userId="user-1" />
      </I18nProvider>,
    );
    const g = screen.getByTestId("speed-chips");
    fireEvent.click(within(g).getByRole("radio", { name: fmt(te.speedValue, { x: 10 }) }));
    const notice = screen.getByTestId("settled");
    const saved = await save();
    const speed = vclips(saved)[0].speed as number;
    expect(speed).toBeGreaterThan(1);
    expect(speed).toBeLessThan(10);
    expect(notice.textContent).toContain(fmt(ct.settledSpeed, { n: 1, max: speed }));
    expect(validateTimeline(saved)).toEqual([]);
  });
});

describe("a saved document that does not fit only because of its fast clips", () => {
  it("says so under the toolbar with the numbers (not the slow-motion sentence)", () => {
    const LONG: EditorAsset = { ...VIDEO, durationS: 3000 };
    const doc = newDocForAsset(LONG)!;
    Object.assign(doc.tracks[0].clips[0], { out_s: 2000, speed: 10 });
    doc.fps = 60;
    render(
      <I18nProvider locale="en">
        <TimelineEditor projectId={PID} title="Trip" rev={1} doc={doc} exports={[]}
          assets={{ [A]: LONG }} videos={[LONG]} userId="user-1" />
      </I18nProvider>,
    );
    const line = screen.getByTestId("render-budget").textContent ?? "";
    expect(line.startsWith(ct.renderBudgetFast.split("{")[0])).toBe(true);
    expect(line).not.toContain(te.fx.renderBudget.split("{")[0]);
  });
});

describe("in every language", () => {
  it("the volume, detach and copy controls have their words", () => {
    for (const [locale, d] of [["ru", ru], ["uz", uz]] as const) {
      cleanup();
      mount(videoDoc(), locale);
      const c = d.editor.clipTools;
      expect(screen.getByRole("slider", { name: new RegExp(`^${c.volume.label}`) })).toBeTruthy();
      expect(screen.getByRole("button", { name: c.detach.button })).toBeTruthy();
      const g = screen.getByRole("group", { name: c.clipboard.group });
      for (const k of ["duplicate", "copy", "paste"] as const)
        expect(within(g).getByRole("button", { name: c.clipboard[k] })).toBeTruthy();
    }
  });
});
