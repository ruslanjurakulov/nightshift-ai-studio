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
  COLOUR_FILTER_ID,
  colourMatrixValues,
} from "@/lib/editorColour";

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
  if (grade) doc.tracks[0].clips[0].color = grade;
  return mount(doc, VIDEO);
};
const slider = (name: string) =>
  screen.getByLabelText(new RegExp(`^${name}`), { selector: "input" }) as HTMLInputElement;
const brightness = () => slider(te.colourBrightness);
const contrast = () => slider(te.colourContrast);
const saturation = () => slider(te.colourSaturation);
const set = (el: HTMLInputElement, v: number) =>
  fireEvent.change(el, { target: { value: String(v) } });
const video = () => document.querySelector("video")!;
const filterOf = () =>
  document.getElementById(COLOUR_FILTER_ID)?.querySelector("feColorMatrix") ?? null;
const savedBody = () => {
  const put = fetchMock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
  )!;
  return JSON.parse(String((put[1] as RequestInit).body));
};

describe("the Colour panel", () => {
  it("is a labelled group of three native sliders, each at no change, and a Reset that has nothing to do yet", () => {
    mountVideo();
    expect(screen.getByRole("group", { name: te.colour })).toBeTruthy();
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
    expect(screen.getByRole("button", { name: te.colourReset })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText(te.colourHint)).toBeTruthy();
  });

  it("a project that never used it draws the picture exactly as before (no filter, no SVG)", () => {
    mountVideo();
    expect(video().style.filter).toBe("");
    expect(document.getElementById(COLOUR_FILTER_ID)).toBeNull();
  });

  it("each slider is 44px tall and keyboard operable (a real range input in the tab order)", () => {
    mountVideo();
    for (const el of [brightness(), contrast(), saturation()]) {
      expect(el.tabIndex).toBe(0);
      expect(el.className).toContain("h-11");
    }
    expect(screen.getByRole("button", { name: te.colourReset }).className).toContain(
      "min-h-11",
    );
  });

  it("moving a slider grades the preview, says unsaved, and is saved with the document", async () => {
    mountVideo();
    set(brightness(), 0.2);
    set(contrast(), 1.3);
    set(saturation(), 0.7);
    expect(video().style.filter).toBe(`url(#${COLOUR_FILTER_ID})`);
    expect(filterOf()?.getAttribute("values")).toBe(colourMatrixValues(GRADE, false));
    expect(brightness().getAttribute("aria-valuetext")).toBe("+20%");
    expect(screen.getByText(te.unsaved)).toBeTruthy();
    expect(screen.getByRole("button", { name: te.colourReset })).toHaveProperty(
      "disabled",
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(screen.getByText(te.saved)).toBeTruthy());
    expect(savedBody().doc.tracks[0].clips[0].color).toEqual(GRADE);
    expect(
      fetchMock.mock.calls.filter(([u]) => String(u).includes("/exports")),
    ).toHaveLength(0);
  });

  it("opens on a saved grade and draws it", () => {
    mountVideo(GRADE);
    expect(brightness().value).toBe("0.2");
    expect(video().style.filter).toBe(`url(#${COLOUR_FILTER_ID})`);
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
    expect(video().style.filter).toBe(`url(#${COLOUR_FILTER_ID})`);
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
    fireEvent.click(screen.getByRole("button", { name: te.colourReset }));
    expect(video().style.filter).toBe("");
    expect(document.getElementById(COLOUR_FILTER_ID)).toBeNull();
    expect(screen.getByRole("button", { name: te.colourReset })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(screen.getByText(te.saved)).toBeTruthy());
    expect("color" in savedBody().doc.tracks[0].clips[0]).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: te.undo }));
    expect(brightness().value).toBe("0.2");
  });

  it("a photo is graded too, with the weights of the still conversion", () => {
    const doc = newDocForAnyAsset(PHOTO)!;
    doc.tracks[0].clips[0].color = GRADE;
    mount(doc, PHOTO);
    const img = document.querySelector("img")!;
    expect(img.style.filter).toBe(`url(#${COLOUR_FILTER_ID})`);
    expect(filterOf()?.getAttribute("values")).toBe(colourMatrixValues(GRADE, true));
    expect(filterOf()?.getAttribute("values")).not.toBe(colourMatrixValues(GRADE, false));
  });

  it("the SVG filter is hidden from assistive technology", () => {
    mountVideo(GRADE);
    const svg = document.getElementById(COLOUR_FILTER_ID)!.closest("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
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
    expect(kept?.doc.tracks[0].clips[0].color).toEqual(GRADE);
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
    expect(video().style.filter).toBe(`url(#${COLOUR_FILTER_ID})`);
  });
});

describe("the strings", () => {
  it("exist in all three languages with their own words", () => {
    for (const d of [en, ru, uz])
      for (const k of [
        "colour",
        "colourBrightness",
        "colourContrast",
        "colourSaturation",
        "colourReset",
        "colourHint",
      ] as const)
        expect(d.editor[k].length).toBeGreaterThan(2);
    expect(ru.editor.colour).not.toBe(en.editor.colour);
    expect(uz.editor.colour).not.toBe(en.editor.colour);
    expect(
      new Set([en, ru, uz].map((d) => d.editor.colourBrightness)).size,
    ).toBe(3);
  });

  it("reads in Russian and Uzbek", () => {
    for (const [locale, d] of [["ru", ru], ["uz", uz]] as const) {
      const doc = newDocForAsset(VIDEO)!;
      const view = mount(doc, VIDEO, locale);
      expect(screen.getByRole("group", { name: d.editor.colour })).toBeTruthy();
      expect(
        screen.getByLabelText(new RegExp(`^${d.editor.colourSaturation}`), {
          selector: "input",
        }),
      ).toBeTruthy();
      view.unmount();
    }
  });
});
