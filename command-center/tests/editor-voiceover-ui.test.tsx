// @vitest-environment jsdom
/**
 * "Record voice-over" in the editor (components/editor/VoiceOverRecorder.tsx), against a fake MediaRecorder, a fake
 * getUserMedia, a fake Web Audio meter and fake timers.
 *
 * What would break without these, one by one: the microphone asked for when the panel opens (it must be only on Record);
 * a take started without a click; the microphone light left on after Stop, Cancel, closing the panel or leaving the
 * page; a take shorter than a second, or one that ran past ten minutes in a paused tab, offered for upload; a refused,
 * missing or site-blocked microphone shown as one message (their remedies differ); a take uploaded twice after the
 * server already has it; a take placed anywhere but where the playhead was when Add was pressed; a refusal of the
 * upload lost; state changes that a screen reader never hears; controls smaller than 44 px or not reachable as
 * buttons; and the three languages drifting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chronos/editor/p",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, fmt, type Locale } from "@/lib/i18n";
import { VoiceOverRecorder, clock } from "@/components/editor/VoiceOverRecorder";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import { VOICEOVER_MAX_SECONDS, type VoiceOverResult } from "@/lib/editor-voiceover";
import { newDocForAsset, toDoc, toModel, validateTimeline, type EditorAsset, type TimelineDoc } from "@/lib/editor";

const LOCALES: Locale[] = ["en", "ru", "uz"];
const tv = (l: Locale = "en") => dictionaries[l].editor.voiceOver;
const ORG = "0a000000-0000-4000-8000-00000000000a";
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VID = "11111111-1111-4111-8111-111111111111";
const VO = "0e000000-0000-4000-8000-00000000000e";
const TICKET = "0c000000-0000-4000-8000-00000000000c";

const VOICE: EditorAsset = { id: VO, kind: "audio", name: "Voice-over 2026-11-11 12-30-05", durationS: 5, width: null, height: null, viewUrl: null, thumbUrl: null };
const VIDEO: EditorAsset = { id: VID, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080, viewUrl: "/v/a", thumbUrl: null };

// ---- the browser's recorder, faked ----------------------------------------------------------------------------------------
const media = {
  tracksStopped: 0,
  getUserMedia: vi.fn(),
  mime: "audio/webm;codecs=opus",
  options: [] as Array<Record<string, unknown> | undefined>,
  contextsClosed: 0,
  contexts: 0,
};
class FakeRecorder {
  static isTypeSupported = (t: string) => t.startsWith("audio/webm") || t === "audio/mp4";
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_s: unknown, opts?: { mimeType?: string }) {
    media.options.push(opts);
    this.mimeType = opts?.mimeType ?? media.mime;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["0123456789".repeat(40)], { type: this.mimeType }) });
    this.onstop?.();
  }
}
class FakeAudioContext {
  constructor() {
    media.contexts++;
  }
  createMediaStreamSource() {
    return { connect: () => {} };
  }
  createAnalyser() {
    return {
      fftSize: 0,
      // A loud-ish signal: every other sample at full swing.
      getByteTimeDomainData: (a: Uint8Array) => a.forEach((_v, i) => (a[i] = i % 2 ? 200 : 56)),
    };
  }
  close() {
    media.contextsClosed++;
  }
}

function install() {
  media.tracksStopped = 0;
  media.options = [];
  media.contexts = 0;
  media.contextsClosed = 0;
  media.getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: () => void media.tracksStopped++ }] }));
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeRecorder;
  (window as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: media.getUserMedia }, configurable: true });
  URL.createObjectURL = vi.fn(() => "blob:fake/take");
  URL.revokeObjectURL = vi.fn();
}
function uninstall() {
  delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  delete (window as { AudioContext?: unknown }).AudioContext;
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
  delete (document as { permissionsPolicy?: unknown }).permissionsPolicy;
}

beforeEach(() => {
  media.mime = "audio/webm;codecs=opus";
  install();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  uninstall();
});

const withI18n = (ui: ReactNode, locale: Locale = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;

function mount(over: Partial<React.ComponentProps<typeof VoiceOverRecorder>> = {}, locale: Locale = "en") {
  const props = {
    orgId: ORG,
    canAdd: true,
    position: vi.fn(() => 2),
    onAdd: vi.fn(() => true),
    onClose: vi.fn(),
    upload: vi.fn(async (): Promise<VoiceOverResult> => ({ ok: true, asset: VOICE })),
    ...over,
  };
  const view = render(withI18n(<VoiceOverRecorder {...props} />, locale));
  return { ...props, view };
}
const status = () => screen.getByTestId("voiceover-status").textContent ?? "";
const alertText = () => screen.queryByTestId("voiceover-error")?.textContent ?? "";
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function press(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}
async function record(seconds: number) {
  vi.useFakeTimers();
  await press(tv().record);
  await advance(seconds * 1000);
  await press(tv().stop);
}

// =================================================================================================================================
describe("the microphone is asked for only on Record", () => {
  it("opening the panel asks for nothing; Record asks once, for sound only", async () => {
    mount();
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(screen.getByText(fmt(tv().hint, { max: "10:00" }))).toBeTruthy();
    await press(tv().record);
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  it("while recording: the elapsed time against the limit, a level meter, Stop and Cancel; the state is announced", async () => {
    mount();
    vi.useFakeTimers();
    await press(tv().record);
    expect(status()).toBe(tv().recording);
    await advance(3000);
    expect(screen.getByTestId("voiceover-elapsed").textContent).toBe(fmt(tv().elapsed, { now: "0:03", max: "10:00" }));
    const meter = screen.getByRole("meter", { name: tv().level });
    expect(Number(meter.getAttribute("aria-valuenow"))).toBeGreaterThan(50);
    expect(screen.getByRole("button", { name: tv().stop })).toBeTruthy();
    expect(screen.getByRole("button", { name: tv().cancel })).toBeTruthy();
    // The ticking clock is not in the live region (a screen reader would hear every second).
    expect(status()).not.toMatch(/0:03/);
    // A known bit rate is asked for, so a long take's size is predictable.
    expect(media.options[0]).toMatchObject({ mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 128000 });
  });

  it("Stop: the take can be heard, re-taken or discarded, and the microphone and meter are released", async () => {
    mount();
    await record(5);
    expect(media.tracksStopped).toBe(1);
    expect(media.contextsClosed).toBe(1);
    expect(status()).toBe(fmt(tv().recorded, { length: "0:05" }));
    const player = screen.getByLabelText(tv().preview) as HTMLAudioElement;
    expect(player.tagName).toBe("AUDIO");
    expect(player.getAttribute("src")).toBe("blob:fake/take");
    expect(screen.getByRole("button", { name: tv().add })).toBeTruthy();
    expect(screen.getByText(fmt(tv().addAt, { at: "0:02" }))).toBeTruthy();
    // Nothing was sent: the take is only offered.
    expect(screen.queryByRole("meter")).toBeNull();

    await press(tv().discard);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake/take");
    expect(screen.queryByLabelText(tv().preview)).toBeNull();
    expect(media.getUserMedia).toHaveBeenCalledTimes(1); // discarding never starts another take
  });

  it("Re-take throws the take away and records again, only because it was pressed", async () => {
    mount();
    await record(2);
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    await press(tv().retake);
    expect(media.getUserMedia).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake/take");
    expect(status()).toBe(tv().recording);
  });

  it("Cancel mid-take keeps nothing and releases the microphone", async () => {
    const p = mount();
    vi.useFakeTimers();
    await press(tv().record);
    await advance(2000);
    await press(tv().cancel);
    expect(media.tracksStopped).toBe(1);
    expect(screen.queryByLabelText(tv().preview)).toBeNull();
    expect(screen.getByRole("button", { name: tv().record })).toBeTruthy();
    expect(p.upload).not.toHaveBeenCalled();
  });

  it("a microphone answer that arrives after Cancel is stopped at once and records nothing", async () => {
    let answer: (v: unknown) => void = () => {};
    media.getUserMedia = vi.fn(() => new Promise((r) => (answer = r)));
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: media.getUserMedia }, configurable: true });
    mount();
    await press(tv().record);
    expect(status()).toBe(tv().requesting);
    await press(tv().cancel);
    await act(async () => answer({ getTracks: () => [{ stop: () => void media.tracksStopped++ }] }));
    expect(media.tracksStopped).toBe(1);
    expect(media.options).toHaveLength(0); // no recorder was made
    expect(screen.queryByRole("button", { name: tv().stop })).toBeNull();
  });
});

describe("a late answer to a cancelled request", () => {
  it("a refusal that arrives after Cancel is not shown as a refusal", async () => {
    let refuse: (e: unknown) => void = () => {};
    media.getUserMedia = vi.fn(() => new Promise((_r, j) => (refuse = j)));
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: media.getUserMedia }, configurable: true });
    mount();
    await press(tv().record);
    await press(tv().cancel);
    await act(async () => refuse(Object.assign(new Error("x"), { name: "NotAllowedError" })));
    expect(alertText()).toBe("");
    expect(screen.getByRole("button", { name: tv().record })).toBeTruthy();
  });
});

describe("leaving releases the microphone", () => {
  it("closing the panel (unmount) mid-take", async () => {
    const p = mount();
    vi.useFakeTimers();
    await press(tv().record);
    p.view.unmount();
    expect(media.tracksStopped).toBe(1);
    expect(media.contextsClosed).toBe(1);
  });

  it("the page being hidden or left (pagehide) mid-take", async () => {
    mount();
    vi.useFakeTimers();
    await press(tv().record);
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(media.tracksStopped).toBe(1);
    expect(screen.getByRole("button", { name: tv().record })).toBeTruthy();
  });

  it("the page being hidden (another tab, a locked phone) stops the take and KEEPS it; a visible page does nothing", async () => {
    const setVisibility = (v: "hidden" | "visible") => Object.defineProperty(document, "visibilityState", { value: v, configurable: true });
    mount();
    vi.useFakeTimers();
    await press(tv().record);
    await advance(4000);
    try {
      setVisibility("visible");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(screen.getByRole("button", { name: tv().stop })).toBeTruthy();
      expect(media.tracksStopped).toBe(0);
      setVisibility("hidden");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
    expect(media.tracksStopped).toBe(1);
    expect(media.contextsClosed).toBe(1);
    expect(status()).toBe(fmt(tv().recorded, { length: "0:04" }));
    expect(screen.getByLabelText(tv().preview)).toBeTruthy();
    expect(screen.getByRole("button", { name: tv().add })).toBeTruthy();
  });

  it("the close button closes the panel", async () => {
    const p = mount();
    await press(tv().close);
    expect(p.onClose).toHaveBeenCalled();
  });
});

describe("refusals, each with its own remedy", () => {
  it.each([
    ["NotAllowedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "noDevice"],
    ["AbortError", "failed"],
  ] as const)("%s reads as %s, and can be tried again", async (name, key) => {
    media.getUserMedia.mockRejectedValueOnce(Object.assign(new Error("x"), { name }));
    mount();
    await press(tv().record);
    expect(alertText()).toBe(tv()[key]);
    expect(screen.getByRole("alert")).toBeTruthy();
    await press(tv().tryAgain);
    expect(media.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("a page whose policy forbids the microphone says so before asking, and offers a reload (not 'blocked')", async () => {
    (document as { permissionsPolicy?: unknown }).permissionsPolicy = { allowsFeature: (f: string) => f !== "microphone" };
    mount();
    await waitFor(() => expect(alertText()).toBe(tv().blockedBySite));
    expect(screen.getByRole("button", { name: tv().reload })).toBeTruthy();
    expect(screen.queryByRole("button", { name: tv().record })).toBeNull();
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });

  it("a browser that cannot record says so and offers no Record", async () => {
    uninstall();
    mount();
    await waitFor(() => expect(alertText()).toBe(tv().unsupported));
    expect(screen.queryByRole("button", { name: tv().record })).toBeNull();
  });

  it("a slip shorter than a second is thrown away and said", async () => {
    vi.useFakeTimers();
    const p = mount();
    await press(tv().record);
    await advance(400);
    await press(tv().stop);
    expect(alertText()).toBe(fmt(tv().tooShort, { length: "0:00", min: "0:01" }));
    expect(screen.queryByRole("button", { name: tv().add })).toBeNull();
    expect(media.tracksStopped).toBe(1);
    expect(p.upload).not.toHaveBeenCalled();
  });

  it("stops itself at ten minutes, and keeps the take, saying why it stopped", async () => {
    mount();
    vi.useFakeTimers();
    await press(tv().record);
    await advance(VOICEOVER_MAX_SECONDS * 1000 + 500);
    expect(screen.queryByRole("button", { name: tv().stop })).toBeNull();
    expect(status()).toBe(`${fmt(tv().recorded, { length: "10:00" })} ${fmt(tv().hitMax, { max: "10:00" })}`);
    expect(media.tracksStopped).toBe(1);
  });

  it("a take that ran past the limit in a paused tab is not kept", async () => {
    mount();
    vi.useFakeTimers();
    await press(tv().record);
    // The tab was in the background: its timers did not run, the recorder did.
    vi.setSystemTime(Date.now() + (VOICEOVER_MAX_SECONDS + 30) * 1000);
    await press(tv().stop);
    expect(alertText()).toBe(fmt(tv().tooLong, { max: "10:00" }));
    expect(screen.queryByRole("button", { name: tv().add })).toBeNull();
  });
});

describe("Add to timeline", () => {
  it("uploads the take as audio with no extension on a WebM name, then places it where the playhead was", async () => {
    const p = mount();
    await record(5);
    await press(tv().add);
    await advance(50);
    expect(p.onAdd).toHaveBeenCalled();
    const arg = (vi.mocked(p.upload).mock.calls[0] as unknown[])[0] as { orgId: string; blob: Blob; type: string; name: string };
    expect(arg.orgId).toBe(ORG);
    expect(arg.type).toBe("audio/webm");
    expect(arg.blob.size).toBe(400);
    expect(arg.name).toMatch(/^Voice-over \d{4}-\d\d-\d\d \d\d-\d\d-\d\d$/);
    expect(p.onAdd).toHaveBeenCalledWith(VOICE, 2);
    expect(status()).toBe(fmt(tv().added, { at: "0:02", name: VOICE.name! }));
    // The take is the library's now: not offered again.
    expect(screen.queryByRole("button", { name: tv().add })).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake/take");
  });

  it("a Safari take (MP4) is named .m4a", async () => {
    media.mime = "audio/mp4";
    FakeRecorder.isTypeSupported = (t: string) => t === "audio/mp4";
    try {
      const p = mount();
      await record(2);
      await press(tv().add);
      await advance(50);
    expect(p.upload).toHaveBeenCalled();
      const arg = (vi.mocked(p.upload).mock.calls[0] as unknown[])[0] as { type: string; name: string };
      expect(arg.type).toBe("audio/mp4");
      expect(arg.name).toMatch(/\.m4a$/);
    } finally {
      FakeRecorder.isTypeSupported = (t: string) => t.startsWith("audio/webm") || t === "audio/mp4";
    }
  });

  it("while it is sent, the buttons wait and the state is announced; a refusal keeps the take for another try", async () => {
    let finish: (r: VoiceOverResult) => void = () => {};
    const upload = vi.fn(() => new Promise<VoiceOverResult>((r) => (finish = r)));
    const p = mount({ upload });
    await record(3);
    await press(tv().add);
    expect(status()).toBe(tv().uploading);
    expect((screen.getByRole("button", { name: tv().add }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: tv().retake }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish({ ok: false, error: "quota_exceeded" }));
    expect(alertText()).toBe(`${tv().uploadFailed}${dictionaries.en.media.errors.quota_exceeded}`);
    expect(p.onAdd).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: tv().add }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each<[VoiceOverResult & { ok: false }, string]>([
    [{ ok: false, error: "network" }, `${tv().uploadFailed}${dictionaries.en.media.errors.network}`],
    [{ ok: false, error: "too_large", maxBytes: 26214400 }, fmt(tv().tooLarge, { max: "25 MB" })],
    [{ ok: false, error: "rejected", reason: "not_media" }, `${tv().rejected}${dictionaries.en.media.reasons.not_media}`],
    [{ ok: false, error: "rejected", reason: null }, `${tv().rejected}${dictionaries.en.media.reasons.other}`],
    [{ ok: false, error: "expired" }, tv().expired],
  ])("%o is said as such, and the take stays to try again", async (result, text) => {
    mount({ upload: vi.fn(async () => result) });
    await record(3);
    await press(tv().add);
    await advance(50);
    expect(alertText()).toBe(text);
    expect(screen.getByRole("button", { name: tv().add })).toBeTruthy();
  });

  it.each<[VoiceOverResult & { ok: false }, keyof ReturnType<typeof tv>]>([
    [{ ok: false, error: "still_checking" }, "stillChecking"],
    [{ ok: false, error: "not_audio" }, "notAudio"],
  ])("after %o the take is the server's: it is not offered again (no second upload)", async (result, key) => {
    mount({ upload: vi.fn(async () => result) });
    await record(3);
    await press(tv().add);
    await advance(50);
    expect(alertText()).toBe(tv()[key]);
    expect(screen.queryByRole("button", { name: tv().add })).toBeNull();
  });

  it("a project that filled up meanwhile: the take is in the library, and the page says so", async () => {
    const p = mount({ onAdd: vi.fn(() => false) });
    await record(3);
    await press(tv().add);
    await advance(50);
    expect(alertText()).toBe(tv().full);
    expect(p.onAdd).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: tv().add })).toBeNull();
  });

  it("a project with no room: Add is disabled and says why, before anything is sent", async () => {
    const p = mount({ canAdd: false });
    await record(3);
    const add = screen.getByRole("button", { name: tv().add }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(add.getAttribute("aria-describedby")!)?.textContent).toBe(tv().full);
    expect(p.upload).not.toHaveBeenCalled();
  });
});

describe("accessibility", () => {
  it("every control is a real button at least 44 px tall, and the state lives in a polite live region", async () => {
    mount();
    const region = screen.getByRole("region", { name: tv().title });
    for (const b of within(region).getAllByRole("button")) {
      expect(b.tagName).toBe("BUTTON");
      expect(b.className).toMatch(/\bmin-h-11\b/);
      expect(b.className).toMatch(/\bmin-w-11\b/);
    }
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    await record(2);
    for (const b of within(region).getAllByRole("button")) expect(b.className).toMatch(/\bmin-h-11\b/);
  });

  it("Space on the take's player is the player's, not the timeline's play shortcut", async () => {
    mount();
    await record(2);
    const player = screen.getByLabelText(tv().preview);
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);
    fireEvent.keyDown(player, { key: " " });
    window.removeEventListener("keydown", onWindow);
    expect(onWindow).not.toHaveBeenCalled();
  });
});

describe("three languages", () => {
  it("every sentence exists in ru and uz with the same placeholders as en", () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const en = tv("en") as Record<string, string>;
    for (const l of ["ru", "uz"] as const) {
      const other = tv(l) as Record<string, string>;
      expect(Object.keys(other).sort()).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en)) {
        expect(other[k].trim().length, `${l}.${k}`).toBeGreaterThan(0);
        expect(placeholders(other[k]), `${l}.${k}`).toEqual(placeholders(en[k]));
      }
    }
  });

  it.each(LOCALES)("the panel speaks %s", async (l) => {
    render(withI18n(<VoiceOverRecorder orgId={ORG} canAdd position={() => 0} onAdd={() => true} onClose={() => {}} />, l));
    expect(screen.getByRole("region", { name: tv(l).title })).toBeTruthy();
    expect(screen.getByRole("button", { name: tv(l).record })).toBeTruthy();
  });

  it("formats the clock as minutes and seconds", () => {
    expect([clock(0), clock(5.9), clock(75), clock(600)]).toEqual(["0:00", "0:05", "1:15", "10:00"]);
  });
});

// =================================================================================================================================
describe("in the editor page", () => {
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  let fetchMock: ReturnType<typeof vi.fn>;
  const doc = (): TimelineDoc => toDoc(toModel(newDocForAsset(VIDEO)!));

  beforeEach(() => {
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/media/uploads" && init?.method === "POST") return json({ ok: true, ticket: TICKET, upload_url: `/api/media/uploads/${TICKET}`, name: "n" });
      if (u === `/api/media/uploads/${TICKET}` && init?.method === "PUT") return json({ ok: true, status: "uploaded" });
      if (u === `/api/media/uploads/${TICKET}`) return json({ ticket: TICKET, status: "ingested", reason: null, asset_id: VO });
      if (u === `/api/media/${VO}`) return json({ asset: { id: VO, kind: "audio", name: VOICE.name, durationS: 5 }, urls: {} });
      if (u.endsWith(`/api/editor/projects/${PID}`) && init?.method === "PUT") return json({ id: PID, rev: 2 });
      return json({ error: "failed" }, 502);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  function mountEditor() {
    return render(
      withI18n(
        <TimelineEditor projectId={PID} title="Trip" rev={1} doc={doc()} exports={[]} assets={{ [VID]: VIDEO }} videos={[VIDEO]} soundFiles={[]} orgId={ORG} />,
      ),
    );
  }

  it("the Record voice-over button opens the panel and asks for no microphone", () => {
    mountEditor();
    const open = screen.getByRole("button", { name: tv().open });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(open);
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("region", { name: tv().title })).toBeTruthy();
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });

  it("record, add: the take goes through the library's upload and lands on an A track at the playhead, and saves", async () => {
    mountEditor();
    fireEvent.change(screen.getByRole("slider", { name: dictionaries.en.editor.playhead }), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: tv().open }));
    await record(5);
    await press(tv().add);
    await advance(2000); // one status read later the worker has registered it
    await advance(50);
    expect(status()).toBe(fmt(tv().added, { at: "0:03", name: VOICE.name! }));
    const urls = fetchMock.mock.calls
      .map(([u, i]) => `${(i as RequestInit | undefined)?.method ?? "GET"} ${String(u)}`)
      .filter((u) => u.includes("/api/media"));
    expect(urls).toEqual(["POST /api/media/uploads", `PUT /api/media/uploads/${TICKET}`, `GET /api/media/uploads/${TICKET}`, `GET /api/media/${VO}`]);
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: dictionaries.en.editor.save }));
    const isSave = ([u, i]: unknown[]) => String(u).endsWith(`/api/editor/projects/${PID}`) && (i as RequestInit | undefined)?.method === "PUT";
    await waitFor(() => expect(fetchMock.mock.calls.some(isSave)).toBe(true));
    const put = fetchMock.mock.calls.find(isSave)!;
    const saved = JSON.parse(String((put[1] as RequestInit).body)).doc as TimelineDoc;
    const a = saved.tracks.filter((t) => t.kind === "A");
    expect(a).toHaveLength(1);
    expect(a[0].clips[0]).toMatchObject({ asset_id: VO, start_s: 3, in_s: 0, out_s: 5 });
    expect(validateTimeline(saved)).toEqual([]);
  });
});
