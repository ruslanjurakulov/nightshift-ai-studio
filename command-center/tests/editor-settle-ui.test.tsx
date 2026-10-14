// @vitest-environment jsdom
/**
 * Edits that move a limit somewhere else (UI half): another frame shape, a deleted
 * clip, a new cross-fade on a big frame. The editor settles the clips that no
 * longer fit (the same policy as a speed change) and SAYS what it changed in a
 * polite live region; undo returns everything; Save never fails with a reason the
 * person did not see. Also: the limit notices are live regions, the clean-up
 * toggles say they are not heard in the preview, and the number boxes show what the
 * document will hold.
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
import {
  MAX_PARTIAL_OPACITY_MOVES,
  SPEED_MAX,
  addClip,
  newDocForAsset,
  setCrossfade,
  toDoc,
  toModel,
  validateTimeline,
  type EditorAsset,
  type TimelineDoc,
} from "@/lib/editor";

const te = en.editor;
const fxe = en.editor.fx;
const st = fxe.settled;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const P = "33333333-3333-4333-8333-333333333333";
const SQUARE: EditorAsset = { id: A, kind: "video", name: "square.mp4", durationS: 300, width: 1080, height: 1080, viewUrl: "/v/a", thumbUrl: null };
const LOGO: EditorAsset = { id: P, kind: "image", name: "logo.png", durationS: null, width: 400, height: 200, viewUrl: "/p/logo", thumbUrl: null };

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

function mount(doc: TimelineDoc, locale: "en" | "ru" | "uz" = "en") {
  return render(
    <I18nProvider locale={locale}>
      <TimelineEditor projectId={PID} title="Trip" rev={1} doc={doc} exports={[]}
        assets={{ [A]: SQUARE, [P]: LOGO }} videos={[SQUARE]} imageFiles={[LOGO]} userId="user-1" />
    </I18nProvider>,
  );
}
/** A square project with one clip; `clip` is merged onto it. */
const squareDoc = (clip: Record<string, unknown> = {}): TimelineDoc => {
  const d = newDocForAsset(SQUARE)!;
  Object.assign(d.tracks[0].clips[0], clip);
  return d;
};
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
const frame = (name: string) => fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${name}`) }));
const settled = () => screen.queryByTestId("settled");
const section = (title: string) => {
  const details = screen.getByText(title).closest("summary")!.parentElement as HTMLDetailsElement;
  if (!details.open) fireEvent.click(details.querySelector("summary")!);
  return details;
};
const clip0 = (d: TimelineDoc) => d.tracks[0].clips[0] as Record<string, unknown>;

describe("switching the frame shape", () => {
  it("shortens a backwards part to the new limit, says so in a live region, and undo returns it", async () => {
    mount(squareDoc({ out_s: 10.2, reverse: true }));
    expect(settled()).toBeNull();
    frame("16:9");
    const note = settled()!;
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toBe(fmt(st.reverse, { n: 1, max: 5.7 }));
    expect((screen.getByRole("spinbutton", { name: te.trimOut }) as HTMLInputElement).value).toBe("5.733");
    expect(validateTimeline(await save())).toEqual([]);
    undo();
    expect(settled()).toBeNull();
    expect((screen.getByRole("spinbutton", { name: te.trimOut }) as HTMLInputElement).value).toBe("10.2");
    expect((screen.getByRole("radio", { name: /^1:1/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("switches smoothing off when it no longer fits, and says so", async () => {
    mount(squareDoc({ out_s: 8.8, speed: 0.5, interpolate: true }));
    frame("9:16");
    expect(settled()!.textContent).toBe(fmt(st.interpolate, { n: 1 }));
    const doc = await save();
    expect(clip0(doc).interpolate).toBeUndefined();
    expect(validateTimeline(doc)).toEqual([]);
    undo();
    expect(clip0(toDoc(toModel(squareDoc({ out_s: 8.8, speed: 0.5, interpolate: true })))).interpolate).toBe(true);
    expect(settled()).toBeNull();
  });

  it("switches steadying off when it no longer fits, and says so", async () => {
    mount(squareDoc({ out_s: 60, stabilize: true }));
    frame("16:9");
    expect(settled()!.textContent).toBe(fmt(st.stabilize, { n: 1 }));
    const doc = await save();
    expect(clip0(doc).stabilize).toBeUndefined();
    expect(validateTimeline(doc)).toEqual([]);
  });

  it("says nothing when everything still fits", () => {
    mount(squareDoc({ out_s: 4, reverse: true }));
    frame("16:9");
    expect(settled()).toBeNull();
    expect((screen.getByRole("spinbutton", { name: te.trimOut }) as HTMLInputElement).value).toBe("4");
  });

  it("the notice is cleared by the next edit that settles nothing", () => {
    mount(squareDoc({ out_s: 10.2, reverse: true }));
    frame("16:9");
    expect(settled()).not.toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: te.fitCover }));
    expect(settled()).toBeNull();
  });
});

describe("other edits that move a limit", () => {
  it("deleting a clip says which steadying went", () => {
    let m = addClip(toModel(squareDoc()), SQUARE);
    m = { ...m, width: 1920, height: 1080, clips: m.clips.map((c, i) => (i === 1 ? { ...c, out_s: 60, stabilize: true } : c)) };
    mount(toDoc(m));
    expect(validateTimeline(toDoc(m))).toEqual([]);
    const lane = within(screen.getByRole("list", { name: te.clipsTrack })).getAllByRole("button");
    fireEvent.click(lane[0]);
    fireEvent.click(screen.getByRole("button", { name: te.deleteClip }));
    expect(settled()!.textContent).toBe(fmt(st.stabilize, { n: 1 }));
  });

  it("a cross-fade on a clip in a frame above 1440p says its blur was removed and its zoom lowered", async () => {
    let m = addClip(toModel(squareDoc()), SQUARE);
    m = { ...m, width: 3840, height: 2160, clips: m.clips.map((c, i) => (i === 0 ? { ...c, blur: 12, move: { from: { zoom: 1 }, to: { zoom: 3 } } } : c)) };
    mount(toDoc(m));
    const lane = within(screen.getByRole("list", { name: te.clipsTrack })).getAllByRole("button");
    fireEvent.click(lane[1]);
    fireEvent.click(screen.getByRole("radio", { name: te.crossfade }));
    const note = settled()!;
    expect(note.textContent).toContain(fmt(st.blur, { n: 1 }));
    expect(note.textContent).toContain(fmt(st.zoom, { n: 1, max: 2 }));
    const doc = await save();
    expect(validateTimeline(doc)).toEqual([]);
    expect(clip0(doc).blur).toBeUndefined();
  });
});

describe("limit notices are live regions", () => {
  it("the budget, large-frame blur and zoom, and the opacity cap are announced", () => {
    // a document that does not fit the time allowance
    let m = addClip(toModel(squareDoc({ out_s: 5, speed: 0.5, interpolate: true })), SQUARE);
    m = { ...m, width: 1920, height: 1080, clips: m.clips.map((c, i) => (i === 1 ? { ...c, out_s: 5, speed: 0.5, interpolate: true } : c)) };
    mount(toDoc(m));
    expect(screen.getByTestId("render-budget").getAttribute("role")).toBe("status");
    cleanup();
    // 4K with a cross-fade: blur and zoom limits
    let big = addClip(toModel(squareDoc()), SQUARE);
    big = { ...big, width: 3840, height: 2160 };
    mount(toDoc(setCrossfade(big, big.clips[1].id, 1)));
    section(fxe.effects.title);
    expect(screen.getByTestId("blur-large").getAttribute("role")).toBe("status");
    fireEvent.click(screen.getByRole("radio", { name: fxe.move.presets.zoomIn }));
    expect(screen.getByTestId("zoom-large").getAttribute("role")).toBe("status");
    cleanup();
    // the opacity cap
    const d = squareDoc();
    d.overlays = ["o1", "o2", "o3"].map((id, i) => ({
      id, asset_id: P, start_s: i * 0.5, end_s: i * 0.5 + 4, x: 0.5, y: 0.5, w: 0.3, opacity: 1,
      ...(i < MAX_PARTIAL_OPACITY_MOVES ? { move: { to: { opacity: 0.5 } } } : {}),
    }));
    mount(d);
    fireEvent.click(screen.getAllByRole("button", { name: /logo\.png/ })[2]);
    const sec = section(fxe.overlayMove.title);
    fireEvent.click(within(sec).getByRole("checkbox", { name: fxe.overlayMove.toggle }));
    const capped = screen.getByTestId("opacity-capped");
    expect(within(capped).getByRole("status").textContent).toContain(fmt(fxe.overlayMove.cap, { max: MAX_PARTIAL_OPACITY_MOVES }));
  });
});

describe("clean-up is not heard in the preview", () => {
  it("a clip's clean-up section says so", () => {
    mount(squareDoc({ audio: true }));
    expect(within(section(fxe.clean.title)).getByTestId("clean-preview-note").textContent).toBe(fxe.clean.previewNote);
  });
});

describe("number boxes show what the document will hold", () => {
  const speedBox = () => screen.getByRole("spinbutton", { name: fmt(fxe.speed.custom, { min: 0.25, max: 4 }) }) as HTMLInputElement;
  it("a speed typed past the range shows the clamped value, even when that is the value already held", () => {
    mount(squareDoc({ out_s: 4, speed: 4 }));
    fireEvent.change(speedBox(), { target: { value: "99" } });
    fireEvent.keyDown(speedBox(), { key: "Enter" });
    expect(speedBox().value).toBe(String(SPEED_MAX));
    fireEvent.change(speedBox(), { target: { value: "0.01" } });
    fireEvent.blur(speedBox());
    expect(speedBox().value).toBe("0.25");
    // the hint the box is described by is the one in the dictionary
    expect(screen.getByText(fmt(fxe.speed.customHint, { min: 0.25, max: 4 }))).toBeTruthy();
    expect(speedBox().getAttribute("aria-describedby")).toBeTruthy();
  });

  it("an angle typed past the range shows the clamped value", () => {
    mount(squareDoc({ angle: 180 }));
    const box = within(section(fxe.crop.title)).getByRole("spinbutton", { name: fxe.crop.angle }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "999" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("180");
  });

  it("the crop sliders end on their step's grid", () => {
    mount(squareDoc({ crop: { x: 0, y: 0, w: 0.563, h: 1 } }));
    const x = within(section(fxe.crop.title)).getByRole("slider", { name: fxe.crop.left }) as HTMLInputElement;
    expect(Number(x.max)).toBeCloseTo(0.43, 5);
    expect(Math.round(Number(x.max) / 0.01) * 0.01).toBeCloseTo(Number(x.max), 6);
  });

  it("a frozen clip's end box is not capped by the file's length", () => {
    mount(squareDoc({ out_s: 4, freeze: true, speed: 1, audio: false }));
    const out = screen.getByRole("spinbutton", { name: te.trimOut }) as HTMLInputElement;
    expect(Number(out.max)).toBeGreaterThan(300);
  });
});

describe("removing a point of the speed curve", () => {
  it("moves focus to Add a point, not to the page", async () => {
    mount(squareDoc({ out_s: 4, speed_curve: [{ at: 0, speed: 1 }, { at: 0.5, speed: 2 }, { at: 1, speed: 1 }] }));
    const sp = fxe.speed;
    const more = section(sp.more);
    const curve = within(more).getByText(sp.curve.title).closest("summary")!.parentElement as HTMLElement;
    fireEvent.click(within(curve).getByRole("button", { name: fmt(sp.curve.remove, { n: 2 }) }));
    await waitFor(() => expect(document.activeElement).toBe(within(curve).getByRole("button", { name: sp.curve.add })));
  });
});

describe("words", () => {
  it("the settled sentences exist in ru and uz with the same placeholders", () => {
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    for (const d of [ru, uz]) {
      for (const k of Object.keys(st) as (keyof typeof st)[]) {
        expect(holes(d.editor.fx.settled[k]), k).toBe(holes(st[k]));
        expect(d.editor.fx.settled[k]).not.toBe(st[k]);
      }
    }
  });
  it("the notices render in ru and uz", () => {
    for (const [loc, d] of [["ru", ru], ["uz", uz]] as const) {
      mount(squareDoc({ out_s: 10.2, reverse: true }), loc);
      fireEvent.click(screen.getByRole("radio", { name: /^16:9/ }));
      expect(screen.getByTestId("settled").textContent).toBe(fmt(d.editor.fx.settled.reverse, { n: 1, max: 5.7 }));
      cleanup();
    }
  });
  it("no unused keys are left in the new dictionary", () => {
    expect((fxe as Record<string, unknown>).approx).toBeUndefined();
    expect((fxe as Record<string, unknown>).reset).toBeUndefined();
    expect((fxe.speed.curve as Record<string, unknown>).off).toBeUndefined();
  });
});
