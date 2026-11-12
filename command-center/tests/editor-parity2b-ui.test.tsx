// @vitest-environment jsdom
/**
 * Editor parity 2b (UI half): the Effects and Animation sections of a video clip, "apply this cross-fade to all
 * cuts", and Beats on a sound. What would break without these: a control that does not reach the saved document,
 * an over-budget change made anyway, a cut button that changes nothing, or beats found and never shown.
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
import { addSound, newDocForAsset, setCrossfade, toDoc, toModel, validateTimeline, type EditorAsset, type TimelineDoc } from "@/lib/editor";
import { resetSilenceAnalysis } from "@/lib/editorSilence";

const te = en.editor;
const p2b = en.editor.parity2b;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const M = "22222222-2222-4222-8222-222222222222";
const VIDEO: EditorAsset = { id: A, kind: "video", name: "trip.mp4", durationS: 20, width: 1920, height: 1080, viewUrl: "/v/a", thumbUrl: null };
const SONG: EditorAsset = { id: M, kind: "audio", name: "song.mp3", durationS: 8, width: null, height: null, viewUrl: "/a/m", thumbUrl: null };

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
      : String(url) === "/a/m"
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
      <TimelineEditor projectId={PID} title="Trip" rev={1} doc={doc} exports={[]}
        assets={{ [A]: VIDEO, [M]: SONG }} videos={[VIDEO]} soundFiles={[SONG]} orgId="0a000000-0000-4000-8000-00000000000a" />
    </I18nProvider>,
  );
}
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

describe("Effects and Animation", () => {
  it("the sliders and the entrance reach the saved document, which validates", async () => {
    mount(newDocForAsset(VIDEO)!);
    const fx = await section(p2b.fx.title);
    fireEvent.change(within(fx).getByRole("slider", { name: p2b.fx.names.glitch }), { target: { value: "70" } });
    const an = await section(p2b.anim.title);
    fireEvent.click(within(within(an).getByTestId("clip-anim-in")).getByRole("radio", { name: p2b.anim.names["slide-up"] }));
    const d = await save();
    expect(clip0(d).fx).toEqual({ glitch: 70 });
    expect(clip0(d)).toMatchObject({ anim_in: "slide-up", anim_in_s: 0.4 });
    expect(validateTimeline(d)).toEqual([]);
  });

  it("an effect that would make the export too long is not made, and the reason is shown", async () => {
    const d = newDocForAsset({ ...VIDEO, durationS: 600 })!;
    mount({ ...d, width: 3840, height: 2160, fps: 60 });
    const fx = await section(p2b.fx.title);
    fireEvent.change(within(fx).getByRole("slider", { name: p2b.fx.names.rgb_split }), { target: { value: "50" } });
    expect(within(fx).getByTestId("fx-budget").textContent).toContain("600 s");
    expect((within(fx).getByRole("slider", { name: p2b.fx.names.rgb_split }) as HTMLInputElement).value).toBe("0");
  });
});

describe("Apply this cross-fade to all cuts", () => {
  it("cross-fades every other cut and says how many", async () => {
    const m = toModel(newDocForAsset(VIDEO)!);
    const two = { ...m, clips: [m.clips[0], { ...m.clips[0], id: "c8", start_s: 20 }, { ...m.clips[0], id: "c9", start_s: 40 }] };
    mount(toDoc(setCrossfade(two, "c8", 0.5)));
    // the first clip selected has no cross-fade into it: select the second one
    fireEvent.click(within(screen.getByRole("list", { name: te.clipsTrack })).getAllByRole("button")[1]);
    await waitFor(() => expect(screen.queryByTestId("crossfade-all")).not.toBeNull());
    fireEvent.click(screen.getByTestId("crossfade-all"));
    expect(screen.getByTestId("crossfade-all-note").textContent).toBe(fmt(p2b.transitionAll.done.one, { n: 1 }));
    const d = await save();
    expect((d.tracks[0].clips as Record<string, unknown>[]).filter((c) => (c.transition as { type?: string } | undefined)?.type === "crossfade").length).toBe(2);
  });
});

describe("Beats", () => {
  it("finds the beats of a sound, marks them on the timeline, and saves nothing for them", async () => {
    const rate = 1000;
    const pcm = new Float32Array(8 * rate).map((_, i) => ((i % 500) < 20 ? 0.8 : 0.001));
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData() {
          return Promise.resolve({ duration: 8, numberOfChannels: 1, sampleRate: rate, getChannelData: () => pcm });
        }
      },
    );
    mount(toDoc(addSound(toModel(newDocForAsset(VIDEO)!), { id: M, durationS: 8 }, 0)!.model));
    fireEvent.click(screen.getByRole("button", { name: /song\.mp3/ }));
    const s = await section(p2b.beats.title);
    fireEvent.click(within(s).getByRole("button", { name: p2b.beats.find }));
    await waitFor(() => expect(within(s).getByTestId("beats-status").textContent).toContain("beats found"));
    expect(document.querySelectorAll("[data-testid=beat-marker]").length).toBeGreaterThan(10);
    // the markers are the editor's: the document has not changed, so there is nothing to save
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === "PUT")).toBe(false);
  });
});
