// @vitest-environment jsdom
/**
 * Editor parity 2 (UI half): the Colour balance, Mask and Remove silences sections of a video clip. What
 * would break without these: a control that does not reach the saved document, a change over the
 * export's time made anyway, a mask the preview does not show, or silences cut before the person agreed.
 * Nothing here renders, spends or publishes; the one "file" is a stub decoded by a stub decoder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chronos/editor/p",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { fmt } from "@/lib/i18n";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import { allowDraftWrites } from "@/lib/editor-draft";
import { newDocForAsset, validateTimeline, type EditorAsset, type TimelineDoc } from "@/lib/editor";
import { resetSilenceAnalysis } from "@/lib/editorSilence";

const te = en.editor;
const p2 = en.editor.parity2;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const VIDEO: EditorAsset = { id: A, kind: "video", name: "talk.mp4", durationS: 10, width: 1920, height: 1080, viewUrl: "/v/a", thumbUrl: null };

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  allowDraftWrites();
  resetSilenceAnalysis();
  fetchMock = vi.fn((url: string, init?: RequestInit) =>
    String(url).endsWith(`/api/editor/projects/${PID}`) && init?.method === "PUT"
      ? json({ id: PID, rev: 2 })
      : String(url) === "/v/a"
        ? Promise.resolve(new Response(new Uint8Array(16)))
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

function mount(doc: TimelineDoc) {
  return render(
    <I18nProvider locale="en">
      <TimelineEditor projectId={PID} title="Talk" rev={1} doc={doc} exports={[]}
        assets={{ [A]: VIDEO }} videos={[VIDEO]} imageFiles={[]} userId="user-1" />
    </I18nProvider>,
  );
}
/** Open a section; its contents are drawn once it is open (a lazy Disclosure). */
const section = async (title: string) => {
  const summary = screen.getByText(title).closest("summary")!;
  const details = summary.parentElement as HTMLDetailsElement;
  if (!details.open) fireEvent.click(summary);
  await waitFor(() => expect(details.querySelector("input, button")).not.toBeNull());
  return details;
};
const save = async () => {
  fireEvent.click(screen.getByRole("button", { name: te.save }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === "PUT")).toBe(true));
  const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!;
  return JSON.parse(String((put[1] as RequestInit).body)).doc as TimelineDoc;
};
const clip0 = (d: TimelineDoc) => d.tracks[0].clips[0] as Record<string, unknown>;

describe("Colour balance", () => {
  it("the sliders and the curve reach the saved document, which validates", async () => {
    mount(newDocForAsset(VIDEO)!);
    const s = await section(p2.color.title);
    fireEvent.change(within(s).getByRole("slider", { name: p2.color.temperature }), { target: { value: "40" } });
    fireEvent.change(within(s).getByRole("slider", { name: p2.color.hue }), { target: { value: "-20" } });
    fireEvent.click(within(s).getByRole("radio", { name: p2.color.curves.matte }));
    const d = await save();
    expect(clip0(d).color).toEqual({ temperature: 40, hue: -20, curve: "matte" });
    expect(validateTimeline(d)).toEqual([]);
  });
});

describe("Mask", () => {
  it("a shape puts a mask on the clip, the preview is clipped to it, and invert is saved", async () => {
    mount(newDocForAsset(VIDEO)!);
    const s = await section(p2.mask.title);
    fireEvent.click(within(s).getByRole("radio", { name: p2.mask.shapes.rounded }));
    expect(within(s).getByRole("slider", { name: p2.mask.radius })).toBeTruthy();
    fireEvent.click(within(s).getByRole("checkbox", { name: p2.mask.invert }));
    expect(document.querySelector("[data-testid=clip-look-preview]")).not.toBeNull();
    const d = await save();
    expect(clip0(d).mask).toEqual({ shape: "rounded", radius: 0.25, invert: true });
  });

  it("a mask that would make the export too long is not put on, and the reason is shown", async () => {
    const d = newDocForAsset({ ...VIDEO, durationS: 600 })!;
    mount({ ...d, width: 3840, height: 2160, fps: 60 });
    const s = await section(p2.mask.title);
    fireEvent.click(within(s).getByRole("radio", { name: p2.mask.shapes.rect }));
    expect(within(s).getByTestId("look-budget").textContent).toContain("600 s");
    expect((within(s).getByRole("radio", { name: p2.mask.none }) as HTMLInputElement).checked).toBe(true);
  });
});

describe("the sections are drawn only when opened", () => {
  it("a closed section holds no controls, so its labels do not crowd the page", () => {
    mount(newDocForAsset(VIDEO)!);
    for (const t of [p2.color.title, p2.mask.title, p2.silence.title]) {
      const d = screen.getByText(t).closest("details")!;
      expect(d.open).toBe(false);
      expect(d.querySelector("input, button")).toBeNull();
    }
  });
});

describe("Remove silences", () => {
  it("finds the quiet parts, proposes cuts, and cuts only when the person applies", async () => {
    const rate = 1000;
    const pcm = new Float32Array(10 * rate).map((_, i) => (i >= 3000 && i < 5000 ? 0 : 0.5));
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData() {
          return Promise.resolve({ duration: 10, numberOfChannels: 1, sampleRate: rate, getChannelData: () => pcm });
        }
      },
    );
    mount(newDocForAsset(VIDEO)!);
    const s = await section(p2.silence.title);
    fireEvent.click(within(s).getByRole("button", { name: p2.silence.find }));
    await waitFor(() => expect(within(s).getByTestId("silence-status").textContent).toBe(fmt(p2.silence.found.one, { n: 1, s: "1.8" })));
    expect(within(s).getByTestId("silence-cuts").textContent).toContain("0:03");
    expect(within(s).getByTestId("silence-keep-times").textContent).toBe(p2.silence.keepTimes);
    fireEvent.click(within(s).getByRole("button", { name: fmt(p2.silence.apply.one, { n: 1 }) }));
    const d = await save();
    expect(d.tracks[0].clips.map((c) => [c.in_s, c.out_s])).toEqual([[0, 3.1], [4.9, 10]]);
    expect(validateTimeline(d)).toEqual([]);
  });
});
