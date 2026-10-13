// @vitest-environment jsdom
/**
 * Picture overlays in the editor: add from the library picker, the inspector's
 * sliders and numbers, the preview drawn with the document's fractions, the
 * selected overlay's frame (arrow keys only while it has focus), undo and
 * Save. Nothing is rendered or spent by any of it.
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
import { fmt } from "@/lib/i18n";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import {
  MAX_OVERLAYS,
  newDocForAsset,
  type EditorAsset,
  type TimelineDoc,
} from "@/lib/editor";

const te = en.editor;
const to = en.editor.overlay;
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "11111111-1111-4111-8111-111111111111";
const P = "33333333-3333-4333-8333-333333333333";
const V2 = "44444444-4444-4444-8444-444444444444";

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
const LOGO: EditorAsset = {
  id: P,
  kind: "image",
  name: "logo.png",
  durationS: null,
  width: 400,
  height: 200,
  viewUrl: "/api/media/file/p/view?sig=1",
  thumbUrl: null,
};
const CLIP: EditorAsset = {
  id: V2,
  kind: "video",
  name: "sticker.mp4",
  durationS: 3,
  width: 640,
  height: 360,
  viewUrl: "/api/media/file/v2/proxy?sig=1",
  thumbUrl: null,
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn((url: string, init?: RequestInit) =>
    String(url).endsWith(`/api/editor/projects/${PID}`) &&
    init?.method === "PUT"
      ? Promise.resolve(
          new Response(JSON.stringify({ id: PID, rev: 2 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
      : Promise.resolve(new Response("{}", { status: 502 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
    Promise.resolve(),
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(doc: TimelineDoc = newDocForAsset(VIDEO)!, locale: "en" | "ru" | "uz" = "en") {
  return render(
    <I18nProvider locale={locale}>
      <TimelineEditor
        projectId={PID}
        title="Trip"
        rev={1}
        doc={doc}
        exports={[]}
        assets={{ [VIDEO.id]: VIDEO, [LOGO.id]: LOGO, [CLIP.id]: CLIP }}
        videos={[VIDEO, CLIP]}
        imageFiles={[LOGO]}
      />
    </I18nProvider>,
  );
}
const savedDoc = () => {
  const put = fetchMock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
  )!;
  return JSON.parse(String((put[1] as RequestInit).body)).doc;
};

async function addLogo() {
  fireEvent.click(screen.getByRole("button", { name: to.add }));
  fireEvent.click(screen.getByRole("button", { name: /logo\.png/ }));
}
const slider = (label: string) =>
  screen.getByRole("slider", { name: label }) as HTMLInputElement;
const number = (label: string) =>
  screen.getByRole("spinbutton", {
    name: fmt(to.numberLabel, { name: label }),
  }) as HTMLInputElement;
const overlayEl = () => document.querySelector<HTMLElement>("[data-overlay]")!;
const frameBtn = () =>
  screen.getByRole("button", { name: fmt(to.handle, { n: 1 }) });

describe("adding an overlay", () => {
  it("lists the library's pictures and videos and adds the one picked", async () => {
    mount();
    expect(screen.queryByRole("list", { name: to.track })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: to.add }));
    const picker = screen.getByRole("region", { name: to.addTitle });
    expect(within(picker).getByText(to.pickerPictures)).toBeTruthy();
    expect(within(picker).getByText(to.pickerVideos)).toBeTruthy();
    expect(within(picker).getByRole("button", { name: /logo\.png/ })).toBeTruthy();
    expect(within(picker).getByRole("button", { name: /sticker\.mp4/ })).toBeTruthy();
    fireEvent.click(within(picker).getByRole("button", { name: /logo\.png/ }));

    // closed, selected, in the lane, in the inspector, drawn in the preview
    expect(screen.queryByRole("region", { name: to.addTitle })).toBeNull();
    expect(screen.getByRole("heading", { name: fmt(to.heading, { n: 1 }) })).toBeTruthy();
    const lane = screen.getByRole("list", { name: to.track });
    expect(within(lane).getAllByRole("listitem")).toHaveLength(1);
    expect(overlayEl()).toBeTruthy();
    expect(screen.getByText(te.unsaved)).toBeTruthy();
  });

  it("the preview uses the document's fractions as percent of the frame", async () => {
    mount();
    await addLogo();
    expect(overlayEl().style).toMatchObject({
      left: "50%",
      top: "50%",
      width: "30%",
      position: "absolute",
    });
    expect(overlayEl().style.aspectRatio).toBe("400 / 200");
    expect(overlayEl().querySelector("img")!.style.opacity).toBe("1");
    // inside the preview box, which clips what leaves the frame
    const box = document.querySelector("video")!.parentElement!;
    expect(box.className).toContain("overflow-hidden");
    expect(box.contains(overlayEl())).toBe(true);
  });

  it("is saved as an overlays list with the defaults and the picture's file", async () => {
    mount();
    await addLogo();
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(screen.getByText(te.saved)).toBeTruthy());
    expect(savedDoc().overlays).toEqual([
      {
        id: expect.any(String),
        asset_id: P,
        start_s: 0,
        end_s: 5,
        x: 0.5,
        y: 0.5,
        w: 0.3,
        opacity: 1,
      },
    ]);
    expect(
      fetchMock.mock.calls.filter(([u]) => String(u).includes("/exports")),
    ).toHaveLength(0);
  });

  it("a video overlay is muted and no longer than the video", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: to.add }));
    fireEvent.click(screen.getByRole("button", { name: /sticker\.mp4/ }));
    const v = overlayEl().querySelector("video")!;
    expect(v.muted).toBe(true);
    expect(screen.getByText(to.videoNote)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(to.end), { target: { value: "9" } });
    fireEvent.blur(screen.getByLabelText(to.end));
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(screen.getByText(te.saved)).toBeTruthy());
    const o = savedDoc().overlays[0];
    expect(o.end_s - o.start_s).toBeLessThanOrEqual(3);
  });
});

describe("the inspector", () => {
  it("a slider and its number change the preview, in whole percent", async () => {
    mount();
    await addLogo();
    fireEvent.change(slider(to.x), { target: { value: "20" } });
    expect(overlayEl().style.left).toBe("20%");
    expect(number(to.x).value).toBe("20");
    fireEvent.change(number(to.y), { target: { value: "75" } });
    fireEvent.blur(number(to.y));
    expect(overlayEl().style.top).toBe("75%");
    fireEvent.change(slider(to.size), { target: { value: "50" } });
    expect(overlayEl().style.width).toBe("50%");
    fireEvent.change(slider(to.opacity), { target: { value: "40" } });
    expect(overlayEl().querySelector("img")!.style.opacity).toBe("0.4");
    expect(slider(to.opacity).getAttribute("aria-valuetext")).toBe("40%");
  });

  it("a number outside its range is kept inside it", async () => {
    mount();
    await addLogo();
    fireEvent.change(number(to.x), { target: { value: "250" } });
    fireEvent.blur(number(to.x));
    expect(overlayEl().style.left).toBe("100%");
    fireEvent.change(number(to.size), { target: { value: "1" } });
    fireEvent.blur(number(to.size));
    expect(overlayEl().style.width).toBe("5%");
    fireEvent.change(number(to.opacity), { target: { value: "abc" } });
    fireEvent.blur(number(to.opacity));
    expect(number(to.opacity).value).toBe("100");
  });

  it("a run of slider moves is one undo step", async () => {
    mount();
    await addLogo();
    for (const v of ["51", "52", "53", "54"])
      fireEvent.change(slider(to.x), { target: { value: v } });
    expect(overlayEl().style.left).toBe("54%");
    fireEvent.click(screen.getByRole("button", { name: te.undo }));
    expect(overlayEl().style.left).toBe("50%");
    fireEvent.click(screen.getByRole("button", { name: te.redo }));
    expect(overlayEl().style.left).toBe("54%");
    // another control is its own step
    fireEvent.change(slider(to.y), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: te.undo }));
    expect(overlayEl().style.top).toBe("50%");
    expect(overlayEl().style.left).toBe("54%");
  });

  it("Reset returns position, size and opacity and keeps the span", async () => {
    mount();
    await addLogo();
    fireEvent.change(slider(to.x), { target: { value: "10" } });
    fireEvent.change(slider(to.size), { target: { value: "80" } });
    fireEvent.change(slider(to.opacity), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText(to.end), { target: { value: "7" } });
    fireEvent.blur(screen.getByLabelText(to.end));
    fireEvent.click(screen.getByRole("button", { name: to.reset }));
    expect(overlayEl().style).toMatchObject({ left: "50%", top: "50%", width: "30%" });
    expect((screen.getByLabelText(to.end) as HTMLInputElement).value).toBe("7");
    fireEvent.click(screen.getByRole("button", { name: te.undo }));
    expect(overlayEl().style.left).toBe("10%");
  });

  it("Delete removes it and a project that never had one saves without the field", async () => {
    mount();
    await addLogo();
    fireEvent.click(screen.getByRole("button", { name: to.delete }));
    expect(document.querySelector("[data-overlay]")).toBeNull();
    expect(screen.getByText(te.saved)).toBeTruthy();
  });

  it("start at the playhead moves the span, keeping its length", async () => {
    mount();
    await addLogo();
    fireEvent.change(screen.getByRole("slider", { name: te.playhead }), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: to.toPlayhead }));
    expect((screen.getByLabelText(to.start) as HTMLInputElement).value).toBe("3");
    expect((screen.getByLabelText(to.end) as HTMLInputElement).value).toBe("8");
  });

  it("layers: forward / backward reorder, the numbers say where it is", async () => {
    mount();
    await addLogo();
    fireEvent.click(screen.getByRole("button", { name: to.add }));
    fireEvent.click(screen.getByRole("button", { name: /sticker\.mp4/ }));
    expect(screen.getByRole("heading", { name: fmt(to.heading, { n: 2 }) })).toBeTruthy();
    expect(screen.getByText(fmt(to.layer, { n: 2, total: 2 }))).toBeTruthy();
    expect(screen.getByRole("button", { name: to.forward })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: to.backward }));
    expect(screen.getByRole("heading", { name: fmt(to.heading, { n: 1 }) })).toBeTruthy();
    expect(screen.getByRole("button", { name: to.backward })).toHaveProperty("disabled", true);
  });

  it("warns when it is invisible, and past the end", async () => {
    mount();
    await addLogo();
    fireEvent.change(slider(to.opacity), { target: { value: "0" } });
    expect(screen.getByText(to.invisible)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(to.start), { target: { value: "20" } });
    fireEvent.blur(screen.getByLabelText(to.start));
    expect(screen.getByText(to.pastEnd)).toBeTruthy();
  });
});

describe("the frame in the preview", () => {
  it("arrow keys move the overlay only while the frame has focus", async () => {
    mount();
    await addLogo();
    // nothing focused: the key does nothing
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(overlayEl().style.left).toBe("50%");
    const frame = frameBtn();
    frame.focus();
    fireEvent.keyDown(frame, { key: "ArrowRight" });
    expect(overlayEl().style.left).toBe("51%");
    fireEvent.keyDown(frame, { key: "ArrowRight", shiftKey: true });
    expect(overlayEl().style.left).toBe("56%");
    fireEvent.keyDown(frame, { key: "ArrowUp" });
    fireEvent.keyDown(frame, { key: "ArrowUp" });
    expect(overlayEl().style.top).toBe("48%");
    fireEvent.keyDown(frame, { key: "ArrowLeft" });
    expect(overlayEl().style.left).toBe("55%");
    // a burst of presses is one undo step
    fireEvent.click(screen.getByRole("button", { name: te.undo }));
    expect(overlayEl().style.left).toBe("50%");
    expect(overlayEl().style.top).toBe("50%");
  });

  it("stops at the edge of the frame", async () => {
    mount();
    await addLogo();
    const frame = frameBtn();
    for (let i = 0; i < 12; i += 1)
      fireEvent.keyDown(frame, { key: "ArrowRight", shiftKey: true });
    expect(overlayEl().style.left).toBe("100%");
  });

  it("has a name, is a button, and gets a fresh frame at each selection", async () => {
    mount();
    await addLogo();
    expect(frameBtn().tagName).toBe("BUTTON");
    expect(frameBtn().getAttribute("aria-label")).toBe(fmt(to.handle, { n: 1 }));
    // selecting the picture clip instead hides it
    fireEvent.click(screen.getByRole("button", { name: /beach\.mp4/ }));
    expect(document.querySelector("[data-testid=overlay-frame]")).toBeNull();
  });

  it("can be dragged: one history step for the whole drag", async () => {
    mount();
    await addLogo();
    const box = document.querySelector("video")!.parentElement!;
    vi.spyOn(box, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200,
      toJSON: () => ({}),
    });
    const frame = frameBtn();
    Object.defineProperty(frame, "offsetParent", { value: box });
    // jsdom's PointerEvent drops clientX: a MouseEvent of the same type carries it
    const at = (type: string, clientX: number, clientY: number) =>
      fireEvent(frame, new MouseEvent(type, { bubbles: true, clientX, clientY }));
    at("pointerdown", 200, 100);
    at("pointermove", 240, 120);
    at("pointermove", 280, 140);
    at("pointerup", 280, 140);
    expect(overlayEl().style.left).toBe("70%");
    expect(overlayEl().style.top).toBe("70%");
    fireEvent.click(screen.getByRole("button", { name: te.undo }));
    expect(overlayEl().style.left).toBe("50%");
  });
});

describe("limits", () => {
  it("the Add button is disabled at the cap, with the reason", () => {
    const doc = newDocForAsset(VIDEO)!;
    doc.overlays = Array.from({ length: MAX_OVERLAYS }, (_, i) => ({
      id: `o${i + 1}`,
      asset_id: P,
      start_s: 0,
      end_s: 2,
      x: 0.5,
      y: 0.5,
      w: 0.3,
      opacity: 1,
    }));
    mount(doc);
    expect(screen.getByRole("button", { name: to.add })).toHaveProperty("disabled", true);
    expect(screen.getByText(fmt(to.full, { max: MAX_OVERLAYS }))).toBeTruthy();
  });

  it("an existing document's overlays open in the editor and are saved back unchanged", async () => {
    const doc = newDocForAsset(VIDEO)!;
    doc.overlays = [
      { id: "o1", asset_id: P, start_s: 1, end_s: 4, x: 0.8, y: 0.2, w: 0.25, opacity: 0.6 },
    ];
    mount(doc);
    expect(screen.getByRole("list", { name: to.track })).toBeTruthy();
    expect(screen.getByText(te.saved)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /logo\.png/ }));
    expect(number(to.x).value).toBe("80");
    expect(number(to.opacity).value).toBe("60");
    fireEvent.change(screen.getByRole("textbox", { name: te.projectTitle }), {
      target: { value: "Trip 2" },
    });
    fireEvent.click(screen.getByRole("button", { name: te.save }));
    await waitFor(() => expect(screen.getByText(te.saved)).toBeTruthy());
    expect(savedDoc().overlays).toEqual(doc.overlays);
  });
});

describe("words", () => {
  it("ru and uz have every string en has, with the same placeholders", () => {
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    for (const [name, d] of [["ru", ru], ["uz", uz]] as const) {
      const keys = Object.keys(to) as (keyof typeof to)[];
      expect(Object.keys(d.editor.overlay).sort(), name).toEqual([...keys].sort());
      for (const k of keys) {
        const v = d.editor.overlay[k];
        expect(v.trim().length, `${name}.${k}`).toBeGreaterThan(0);
        expect(holes(v), `${name}.${k}`).toBe(holes(to[k]));
      }
    }
  });

  it("uz uses the modifier apostrophe, never a straight one", () => {
    for (const v of Object.values(uz.editor.overlay)) expect(v).not.toMatch(/[a-z]'[a-z]/i);
  });

  it("renders in Russian and Uzbek", async () => {
    for (const [locale, d] of [["ru", ru], ["uz", uz]] as const) {
      const { unmount } = mount(newDocForAsset(VIDEO)!, locale);
      fireEvent.click(screen.getByRole("button", { name: d.editor.overlay.add }));
      fireEvent.click(screen.getByRole("button", { name: /logo\.png/ }));
      expect(screen.getByRole("heading", { name: fmt(d.editor.overlay.heading, { n: 1 }) })).toBeTruthy();
      unmount();
    }
  });
});
