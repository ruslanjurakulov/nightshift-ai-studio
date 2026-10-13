// @vitest-environment jsdom
/**
 * The Colour panel in the editor: three native sliders and a Reset for the
 * selected clip. Every change is an undoable document edit that the preview
 * draws (a CSS filter onto an SVG feColorMatrix), Save sends, the local draft
 * keeps; one drag is one undo step. Nothing is rendered or spent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const router = {
  push: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
};
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/chronos/editor/p",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import {
  DRAFT_DEBOUNCE_MS,
  allowDraftWrites,
  draftKey,
  readDraft,
} from "@/lib/editor-draft";
import {
  newDocForAnyAsset,
  newDocForAsset,
  type EditorAsset,
  type TimelineDoc,
} from "@/lib/editor";
import {
  GRADE_FILTER_ID,
  gradeMatrixValues,
} from "@/lib/editorGrade";

const te = en.editor;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const P = "33333333-3333-4333-8333-333333333333";
const VIDEO: EditorAsset = {
  id: A,
  kind: "video",
  name: "beach.mp4",
  durationS: 10,
  width: 1920,
  height: 1080,
  viewUrl: "/api/media/file/a/proxy?sig=1",
  thumbUrl: null,
};
const PHOTO: EditorAsset = {
  id: P,
  kind: "image",
  name: "photo.jpg",
  durationS: null,
  width: 1200,
  height: 800,
  viewUrl: "/api/media/file/p/view?sig=1",
  thumbUrl: null,
};
const GRADE = { brightness: 0.2, contrast: 1.3, saturation: 0.7 };

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  allowDraftWrites();
  fetchMock = vi.fn((url: string, init?: RequestInit) =>
    String(url).endsWith(`/api/editor/projects/${PID}`) &&
    init?.method === "PUT"
      ? json({ id: PID, rev: 2 })
      : json({ error: "failed" }, 502),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
    Promise.resolve(),
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(doc: TimelineDoc, asset: EditorAsset, locale: "en" | "ru" | "uz" = "en") {
  return render(
    <I18nProvider locale={locale}>
      <TimelineEditor
        projectId={PID}
        title="Trip"
        rev={1}
        doc={doc}
        exports={[]}
        assets={{ [asset.id]: asset }}
        videos={[VIDEO]}
        userId="user-1"
      />
    </I18nProvider>,
  );
}
const mountVideo = (grade?: typeof GRADE) => {
  const doc = newDocForAsset(VIDEO)!;
  if (grade) doc.tracks[0].clips[0].grade = grade;
  return mount(doc, VIDEO);
};
const slider = (name: string) =>
  screen.getByLabelText(new RegExp(`^${name}`), { selector: "input" }) as HTMLInputElement;
const brightness = () => slider(te.gradeBrightness);
const contrast = () => slider(te.gradeContrast);
const saturation = () => slider(te.gradeSaturation);
const set = (el: HTMLInputElement, v: number) =>
  fireEvent.change(el, { target: { value: String(v) } });
const video = () => document.querySelector("video")!;
const filterOf = () =>
  document.getElementById(GRADE_FILTER_ID)?.querySelector("feColorMatrix") ?? null;
const savedBody = () => {
  const put = fetchMock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
  )!;
  return JSON.parse(String((put[1] as RequestInit).body));
};

describe("the Colour panel", () => {
  it("is a labelled group of three native sliders, each at no change, and a Reset that has nothing to do yet", () => {
    mountVideo();
    expect(screen.getByRole("group", { name: te.grade })).toBeTruthy();
    for (const [el, min, max, now] of [
      [brightness(), "-1", "1", "0"],
      [contrast(), "0", "2", "1"],
      [saturation(), "0", "3", "1"],
    ] as const) {
      expect(el.type).toBe("range");
      expect([el.min, el.max, el.value]).toEqual([min, max, now]);
      expect(el.step).toBe("0.05");
    }
    expect(brightness().getAttribute("aria-valuetext")).toBe("0%");
    expect(saturation().getAttribute("aria-valuetext")).toBe("100%");
    expect(screen.getByRole("button", { name: te.gradeReset }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(te.gradeHint)).toBeTruthy();
  });

  it("a project that never used it draws the picture exactly as before (no filter, no SVG)", () => {
    mountVideo();
    expect(video().style.filter).toBe("");
    expect(document.getElementById(GRADE_FILTER_ID)).toBeNull();
  });

  it("each slider is 44px tall and keyboard operable (a real range input in the tab order)", () => {
    mountVideo();
    for (const el of [brightness(), contrast(), saturation()]) {
      expect(el.tabIndex).toBe(0);
      expect(el.className).toContain("h-11");
    }
    expect(screen.getByRole("button", { name: te.gradeReset }).className).toContain(
      "min-h-11",
    );
  });

  it("moving a slider grades the preview, says unsaved, and is saved with the document", async () => {
    mountVideo();
    set(brightness(), 0.2);
    set(contrast(), 1.3);
    set(saturation(), 0.7);
    expect(video().style.filter).toBe(`url(#${GRADE_FILTER_ID})`);
    expect(filterOf()?.getAttribute("values")).toBe(gradeMatrixValues(GRADE, false));
    expect(brightness().getAttribute("aria-valuetext")).toBe("+20%");
    expect(screen.getByText(te.unsaved)).toBeTruthy();
    expect(screen.getByRole("button", { name: te.gradeReset }).getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(screen.getByText(te.saved)).toBeTruthy());
    expect(savedBody().doc.tracks[0].clips[0].grade).toEqual(GRADE);
    expect(
      fetchMock.mock.calls.filter(([u]) => String(u).includes("/exports")),
    ).toHaveLength(0);
  });

  it("opens on a saved grade and draws it", () => {
    mountVideo(GRADE);
    expect(brightness().value).toBe("0.2");
    expect(video().style.filter).toBe(`url(#${GRADE_FILTER_ID})`);
  });

  it("undo and redo walk through the grade", () => {
    mountVideo();
    set(brightness(), 0.2);
    fireEvent.click(screen.getByRole("button", { name: te.undo }));
    expect(brightness().value).toBe("0");
    expect(video().style.filter).toBe("");
    expect(screen.getByText(te.saved)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: te.redo }));
    expect(brightness().value).toBe("0.2");
    expect(video().style.filter).toBe(`url(#${GRADE_FILTER_ID})`);
  });

  it("one drag is one undo step, the next drag another", () => {
    mountVideo();
    fireEvent.pointerDown(contrast());
    set(contrast(), 1.1);
    set(contrast(), 1.2);
    set(contrast(), 1.3);
    fireEvent.pointerDown(contrast());
    set(contrast(), 1.5);
    set(contrast(), 1.6);
    expect(contrast().value).toBe("1.6");
    const undo = screen.getByRole("button", { name: te.undo });
    fireEvent.click(undo);
    expect(contrast().value).toBe("1.3");
    fireEvent.click(undo);
    expect(contrast().value).toBe("1");
    expect(undo).toHaveProperty("disabled", true);
  });

  it("a key press is its own step; holding the key is one gesture", () => {
    mountVideo();
    fireEvent.keyDown(saturation(), { key: "ArrowRight" });
    set(saturation(), 1.05);
    fireEvent.keyDown(saturation(), { key: "ArrowRight" });
    set(saturation(), 1.1);
    fireEvent.keyDown(saturation(), { key: "ArrowRight", repeat: true });
    set(saturation(), 1.15);
    const undo = screen.getByRole("button", { name: te.undo });
    fireEvent.click(undo);
    expect(saturation().value).toBe("1.05");
    fireEvent.click(undo);
    expect(saturation().value).toBe("1");
  });

  it("Reset returns to a document without the field, in one undoable step", async () => {
    mountVideo(GRADE);
    fireEvent.click(screen.getByRole("button", { name: te.gradeReset }));
    expect(video().style.filter).toBe("");
    expect(document.getElementById(GRADE_FILTER_ID)).toBeNull();
    expect(screen.getByRole("button", { name: te.gradeReset }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(screen.getByText(te.saved)).toBeTruthy());
    expect("grade" in savedBody().doc.tracks[0].clips[0]).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: te.undo }));
    expect(brightness().value).toBe("0.2");
  });

  it("Reset keeps the keyboard's focus when it makes the grade neutral, and does nothing when it already is", () => {
    mountVideo(GRADE);
    const reset = screen.getByRole("button", { name: te.gradeReset });
    expect(reset).toHaveProperty("disabled", false);
    reset.focus();
    fireEvent.click(reset);
    expect(brightness().value).toBe("0");
    // not `disabled`: still a focusable button, and it still holds the focus
    expect(reset).toHaveProperty("disabled", false);
    expect(reset.getAttribute("aria-disabled")).toBe("true");
    expect(reset.tabIndex).toBe(0);
    expect(document.activeElement).toBe(reset);
    // a neutral grade: pressing it again changes nothing (no history step)
    fireEvent.click(reset);
    fireEvent.click(screen.getByRole("button", { name: te.undo }));
    expect(brightness().value).toBe("0.2"); // one undo goes straight back to the grade
    fireEvent.click(screen.getByRole("button", { name: te.undo }));
    expect(screen.getByRole("button", { name: te.undo })).toHaveProperty("disabled", true);
  });

  it("a photo is graded too, with the weights of the still conversion", () => {
    const doc = newDocForAnyAsset(PHOTO)!;
    doc.tracks[0].clips[0].grade = GRADE;
    mount(doc, PHOTO);
    const img = document.querySelector("img")!;
    expect(img.style.filter).toBe(`url(#${GRADE_FILTER_ID})`);
    expect(filterOf()?.getAttribute("values")).toBe(gradeMatrixValues(GRADE, true));
    expect(filterOf()?.getAttribute("values")).not.toBe(gradeMatrixValues(GRADE, false));
  });

  it("the SVG filter is hidden from assistive technology", () => {
    mountVideo(GRADE);
    const svg = document.getElementById(GRADE_FILTER_ID)!.closest("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
  });
});

describe("the preview shows the clip being graded", () => {
  const twoClips = (): TimelineDoc => {
    const d = newDocForAsset(VIDEO)!;
    d.tracks[0].clips = [
      { id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 3 },
      { id: "c2", asset_id: A, start_s: 3, in_s: 3, out_s: 6 },
    ];
    return d;
  };
  const playhead = () =>
    screen.getByRole("slider", { name: te.playhead }) as HTMLInputElement;
  const clipButtons = () =>
    within(screen.getByRole("list", { name: te.clipsTrack })).getAllByRole("button");

  it("moving a slider of a clip that is not under the playhead brings the playhead to it", () => {
    mount(twoClips(), VIDEO);
    expect(Number(playhead().value)).toBe(0);
    fireEvent.click(clipButtons()[1]); // select clip 2; the playhead stays at 0
    expect(Number(playhead().value)).toBe(0);
    expect(video().style.filter).toBe("");
    set(brightness(), 0.2);
    expect(Number(playhead().value)).toBe(3); // clip 2 starts at 3 s
    expect(video().style.filter).toBe(`url(#${GRADE_FILTER_ID})`);
  });

  it("leaves the playhead alone when the clip is already on screen", () => {
    mount(twoClips(), VIDEO);
    fireEvent.change(playhead(), { target: { value: "1.5" } });
    set(brightness(), 0.2);
    expect(Number(playhead().value)).toBe(1.5);
  });

  it("Reset does the same, and the playhead is not chased afterwards", () => {
    const doc = twoClips();
    doc.tracks[0].clips[1].grade = GRADE;
    mount(doc, VIDEO);
    fireEvent.click(clipButtons()[1]);
    fireEvent.click(screen.getByRole("button", { name: te.gradeReset }));
    expect(Number(playhead().value)).toBe(3);
    // the user moves the playhead away: a later change shows nothing, then it follows again
    fireEvent.change(playhead(), { target: { value: "0.5" } });
    expect(Number(playhead().value)).toBe(0.5);
  });

  it("with a cross-fade it goes to the first frame the clip is the one shown", () => {
    const doc = twoClips();
    doc.tracks[0].clips[1] = {
      id: "c2", asset_id: A, start_s: 2.5, in_s: 3, out_s: 6,
      transition: { type: "crossfade", duration_s: 0.5 },
    };
    mount(doc, VIDEO);
    fireEvent.click(clipButtons()[1]);
    set(contrast(), 1.2);
    // the dissolve (2.5-3 s) still shows clip 1: clip 2 is on screen from 3 s
    expect(Number(playhead().value)).toBeCloseTo(3, 2);
  });
});

describe("the local draft carries the grade", () => {
  it("keeps it on this device and offers it back", async () => {
    vi.useFakeTimers();
    const first = mountVideo();
    set(brightness(), 0.2);
    set(contrast(), 1.3);
    set(saturation(), 0.7);
    act(() => void vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS));
    const kept = readDraft("user-1", PID, 1);
    expect(kept?.doc.tracks[0].clips[0].grade).toEqual(GRADE);
    expect(localStorage.getItem(draftKey("user-1", PID, 1))).not.toBeNull();
    first.unmount();
    vi.useRealTimers();

    mountVideo();
    await screen.findByRole("region", { name: te.draftRegion });
    expect(brightness().value).toBe("0"); // nothing applied until asked
    fireEvent.click(screen.getByRole("button", { name: te.draftRestore }));
    expect(brightness().value).toBe("0.2");
    expect(contrast().value).toBe("1.3");
    expect(saturation().value).toBe("0.7");
    expect(video().style.filter).toBe(`url(#${GRADE_FILTER_ID})`);
  });
});

describe("the strings", () => {
  it("exist in all three languages with their own words", () => {
    for (const d of [en, ru, uz])
      for (const k of [
        "grade",
        "gradeBrightness",
        "gradeContrast",
        "gradeSaturation",
        "gradeReset",
        "gradeHint",
      ] as const)
        expect(d.editor[k].length).toBeGreaterThan(2);
    expect(ru.editor.grade).not.toBe(en.editor.grade);
    expect(uz.editor.grade).not.toBe(en.editor.grade);
    expect(
      new Set([en, ru, uz].map((d) => d.editor.gradeBrightness)).size,
    ).toBe(3);
  });

  it("reads in Russian and Uzbek", () => {
    for (const [locale, d] of [["ru", ru], ["uz", uz]] as const) {
      const doc = newDocForAsset(VIDEO)!;
      const view = mount(doc, VIDEO, locale);
      expect(screen.getByRole("group", { name: d.editor.grade })).toBeTruthy();
      expect(
        screen.getByLabelText(new RegExp(`^${d.editor.gradeSaturation}`), {
          selector: "input",
        }),
      ).toBeTruthy();
      view.unmount();
    }
  });
});
