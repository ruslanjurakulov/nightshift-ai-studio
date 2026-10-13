// @vitest-environment jsdom
/**
 * The editor's keyboard shortcuts, timeline zoom, snap switch and the
 * shortcuts help, in a browser-like DOM. The maths is tested in
 * editor-timeline-view.test.ts and editor-shortcuts.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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
import { newDocForAsset, type EditorAsset } from "@/lib/editor";

const te = en.editor;
const tv = te.view;
const A = "11111111-1111-4111-8111-111111111111";
const ASSET: EditorAsset = {
  id: A, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080,
  viewUrl: "/api/media/file/a/proxy?sig=1", thumbUrl: null,
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 502 }))));
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(locale: "en" | "ru" | "uz" = "en") {
  return render(
    <I18nProvider locale={locale}>
      <TimelineEditor
        projectId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        title="Trip"
        rev={1}
        doc={newDocForAsset(ASSET)!}
        exports={[]}
        assets={{ [A]: ASSET }}
        videos={[ASSET]}
      />
    </I18nProvider>,
  );
}
const clipButtons = () => within(screen.getByRole("list", { name: te.clipsTrack })).getAllByRole("button");
const playhead = () => screen.getByRole("slider", { name: te.playhead }) as HTMLInputElement;
const key = (k: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
  fireEvent.keyDown(target, { key: k, ...init });

describe("keyboard shortcuts", () => {
  it("Space plays and pauses", () => {
    mount();
    expect(screen.getByRole("button", { name: te.play })).toBeTruthy();
    key(" ");
    expect(screen.getByRole("button", { name: te.pause })).toBeTruthy();
    key(" ");
    expect(screen.getByRole("button", { name: te.play })).toBeTruthy();
  });

  it("S splits the clip at the playhead, and Ctrl+Z undoes it", () => {
    mount();
    fireEvent.change(playhead(), { target: { value: "4" } });
    key("s");
    expect(clipButtons()).toHaveLength(2);
    key("z", { ctrlKey: true });
    expect(clipButtons()).toHaveLength(1);
    // outside the clip nothing happens
    fireEvent.change(playhead(), { target: { value: "0" } });
    key("s");
    expect(clipButtons()).toHaveLength(1);
  });

  it("Delete removes the selected clip (never the last one) and Backspace does the same", () => {
    mount();
    fireEvent.change(playhead(), { target: { value: "4" } });
    key("s");
    expect(clipButtons()).toHaveLength(2);
    fireEvent.click(clipButtons()[1]);
    key("Delete");
    expect(clipButtons()).toHaveLength(1);
    key("Backspace");
    expect(clipButtons()).toHaveLength(1);
  });

  it("the arrows step the playhead a frame, Shift a second", () => {
    mount();
    fireEvent.change(playhead(), { target: { value: "4" } });
    key("ArrowRight");
    expect(Number(playhead().value)).toBeCloseTo(4 + 1 / 30, 2);
    key("ArrowLeft", { shiftKey: true });
    expect(Number(playhead().value)).toBeCloseTo(3 + 1 / 30, 2);
    key("ArrowLeft", { shiftKey: true });
    key("ArrowLeft", { shiftKey: true });
    key("ArrowLeft", { shiftKey: true });
    key("ArrowLeft", { shiftKey: true });
    expect(Number(playhead().value)).toBe(0);
  });

  it("does nothing while the cursor is in a text field", () => {
    mount();
    const title = screen.getByLabelText(te.projectTitle) as HTMLInputElement;
    title.focus();
    key(" ", {}, title);
    key("s", {}, title);
    key("Delete", {}, title);
    key("ArrowRight", {}, title);
    expect(screen.getByRole("button", { name: te.play })).toBeTruthy();
    expect(Number(playhead().value)).toBe(0);
  });

  it("leaves Space to a focused button and the arrows to a focused slider", () => {
    mount();
    const play = screen.getByRole("button", { name: te.play });
    key(" ", {}, play);
    expect(screen.getByRole("button", { name: te.play })).toBeTruthy();
    fireEvent.change(playhead(), { target: { value: "4" } });
    key("ArrowRight", {}, playhead());
    expect(Number(playhead().value)).toBe(4);
  });
});

describe("zoom and snap", () => {
  it("the buttons zoom in and out and fit; at the ends they read as unavailable but keep focus", () => {
    mount();
    const level = () => screen.getByText(/%$/).textContent;
    const out = screen.getByRole("button", { name: tv.zoomOut });
    const inn = screen.getByRole("button", { name: tv.zoomIn });
    const fit = screen.getByRole("button", { name: tv.fitLabel });
    expect(level()).toBe(fmt(tv.zoomLevel, { pct: 100 }));
    expect(out.getAttribute("aria-disabled")).toBe("true");
    expect(fit.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(inn);
    expect(level()).toBe(fmt(tv.zoomLevel, { pct: 150 }));
    expect(out.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(inn);
    expect(level()).toBe(fmt(tv.zoomLevel, { pct: 225 }));
    const strip = screen.getByRole("group", { name: te.timeline }).firstElementChild as HTMLElement;
    expect(strip.style.minWidth).toContain("225%");
    fireEvent.click(fit);
    expect(level()).toBe(fmt(tv.zoomLevel, { pct: 100 }));
  });

  it("+ - and 0 zoom from the keyboard; Ctrl+wheel over the timeline zooms too", () => {
    mount();
    const level = () => screen.getByText(/%$/).textContent;
    key("+");
    expect(level()).toBe(fmt(tv.zoomLevel, { pct: 150 }));
    key("-");
    expect(level()).toBe(fmt(tv.zoomLevel, { pct: 100 }));
    key("+");
    key("0");
    expect(level()).toBe(fmt(tv.zoomLevel, { pct: 100 }));
    const scroller = screen.getByRole("group", { name: te.timeline });
    // a plain wheel scrolls as before
    fireEvent.wheel(scroller, { deltaY: -120 });
    expect(level()).toBe(fmt(tv.zoomLevel, { pct: 100 }));
    const ev = new WheelEvent("wheel", { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      scroller.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(Number((level() ?? "").replace(/\D/g, ""))).toBeGreaterThan(100);
  });

  it("the snap switch is a toggle button that starts on", () => {
    mount();
    const snap = screen.getByRole("button", { name: tv.snap });
    expect(snap.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(snap);
    expect(snap.getAttribute("aria-pressed")).toBe("false");
    expect(snap.getAttribute("aria-describedby")).toBeTruthy();
  });
});

describe("the shortcuts help", () => {
  it("opens a dialog with the keys, Escape closes it and focus goes back to the button", () => {
    mount();
    const opener = screen.getByRole("button", { name: tv.shortcuts });
    opener.focus();
    fireEvent.click(opener);
    const dlg = screen.getByRole("dialog", { name: tv.shortcutsTitle });
    expect(within(dlg).getByText(tv.scPlay)).toBeTruthy();
    expect(within(dlg).getByText(tv.scSplit)).toBeTruthy();
    expect(document.activeElement).toBe(within(dlg).getByRole("button", { name: tv.close }));
    // keys pressed inside the dialog do not drive the editor
    key(" ", {}, within(dlg).getByRole("button", { name: tv.close }));
    expect(screen.getByRole("button", { name: te.play })).toBeTruthy();
    fireEvent.keyDown(dlg, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("the close button closes it too", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: tv.shortcuts }));
    fireEvent.click(screen.getByRole("button", { name: tv.close }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("translations", () => {
  it("ru and uz have every key of the view group, and the zoom label keeps its placeholder", () => {
    const keys = Object.keys(tv).sort();
    expect(Object.keys(ru.editor.view).sort()).toEqual(keys);
    expect(Object.keys(uz.editor.view).sort()).toEqual(keys);
    for (const d of [en, ru, uz]) expect(d.editor.view.zoomLevel).toContain("{pct}");
  });

  it("the toolbar reads in Russian", () => {
    mount("ru");
    expect(screen.getByRole("button", { name: ru.editor.view.shortcuts })).toBeTruthy();
    expect(screen.getByRole("button", { name: ru.editor.view.snap })).toBeTruthy();
  });
});
