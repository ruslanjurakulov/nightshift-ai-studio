// @vitest-environment jsdom
/**
 * Regressions found in review of the editor view work: the zoom anchor vs the
 * playhead-reveal effect, slow wheel zoom, the modal shortcuts dialog and the
 * page behind it, the scope of the single-key shortcuts, the playhead drag
 * snap, and S with a stale selection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chronos/editor/p",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import { useTimelineView, type TimelineView } from "@/components/editor/useTimelineView";
import { newDocForAsset, type EditorAsset } from "@/lib/editor";

/** The zoom readout lives in the timeline-view toolbar; the clip colour panel also shows "N%" readouts. */
const zoomText = (re: RegExp) => within(screen.getByRole("group", { name: en.editor.view.toolbar })).getByText(re);


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

// ── the hook against a scroll box with real-looking geometry ─────────────────

/** A 1000px window whose strip is 1000 x zoom + 500px (the 44px-a-clip minimum makes it wider than zoom x window). */
function Probe({ total, playhead, out }: { total: number; playhead: number; out: { view?: TimelineView; el?: HTMLDivElement } }) {
  const view = useTimelineView({ total, playhead });
  out.view = view;
  useEffect(() => {
    out.view = view;
  });
  return (
    <div
      data-testid="scroller"
      ref={(el) => {
        if (el && !out.el) {
          out.el = el;
          Object.defineProperty(el, "clientWidth", { value: 1000, configurable: true });
          Object.defineProperty(el, "scrollWidth", { get: () => 1000 * (out.view?.zoom ?? 1) + 500, configurable: true });
          let left = 0;
          Object.defineProperty(el, "scrollLeft", { get: () => left, set: (v: number) => void (left = v), configurable: true });
        }
        view.setScroller(el);
      }}
    />
  );
}

describe("zoom keeps its anchor even when the playhead is off-screen", () => {
  it("Ctrl+wheel at x=800 holds the point under the pointer; the reveal effect does not scroll back to the playhead", () => {
    const out: { view?: TimelineView; el?: HTMLDivElement } = {};
    render(<Probe total={100} playhead={0} out={out} />);
    const el = out.el!;
    el.scrollLeft = 300; // the playhead (x = 0) is already off-screen to the left
    const ev = new WheelEvent("wheel", { deltaY: -240, ctrlKey: true, clientX: 800, bubbles: true, cancelable: true });
    act(() => {
      el.dispatchEvent(ev);
    });
    const z = out.view!.zoom;
    expect(z).toBeGreaterThan(1.5);
    expect(ev.defaultPrevented).toBe(true);
    const prevW = 1000 + 500;
    const nextW = 1000 * z + 500;
    const expected = ((300 + 800) / prevW) * nextW - 800;
    expect(el.scrollLeft).toBeCloseTo(expected, 3);
    expect(el.scrollLeft).toBeGreaterThan(300);
  });

  it("the buttons' / keys' zoom (no pointer) does not snap back to the playhead either", () => {
    const out: { view?: TimelineView; el?: HTMLDivElement } = {};
    render(<Probe total={100} playhead={5} out={out} />);
    const el = out.el!;
    act(() => out.view!.zoomIn());
    expect(out.view!.zoom).toBe(1.5);
    el.scrollLeft = 900; // the user scrolled away: the playhead (5% of 2000px = x 100) is off-screen to the left
    act(() => out.view!.zoomIn());
    const z = out.view!.zoom;
    expect(z).toBe(2.25);
    // anchored at the window's centre (500px), not pulled back to the playhead
    const expected = ((900 + 500) / 2000) * (1000 * z + 500) - 500;
    expect(el.scrollLeft).toBeCloseTo(expected, 3);
  });

  it("a playhead that MOVES out of the window is still brought back", () => {
    const out: { view?: TimelineView; el?: HTMLDivElement } = {};
    const { rerender } = render(<Probe total={100} playhead={0} out={out} />);
    act(() => out.view!.zoomIn());
    const el = out.el!;
    el.scrollLeft = 0;
    rerender(<Probe total={100} playhead={95} out={out} />);
    expect(el.scrollLeft).toBeGreaterThan(0);
  });

  it("several wheel events in one frame accumulate (the next starts from the zoom the last one set)", () => {
    const out: { view?: TimelineView; el?: HTMLDivElement } = {};
    render(<Probe total={100} playhead={0} out={out} />);
    const el = out.el!;
    const wheel = () => new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, clientX: 500, bubbles: true, cancelable: true });
    act(() => {
      el.dispatchEvent(wheel());
    });
    const one = out.view!.zoom;
    cleanup();
    const out2: { view?: TimelineView; el?: HTMLDivElement } = {};
    render(<Probe total={100} playhead={0} out={out2} />);
    act(() => {
      out2.el!.dispatchEvent(wheel());
      out2.el!.dispatchEvent(wheel());
      out2.el!.dispatchEvent(wheel());
    });
    expect(out2.view!.zoom).toBeGreaterThan(one * 1.5);
  });

  it("a slow pinch from fit (tiny deltas) leaves fit", () => {
    const out: { view?: TimelineView; el?: HTMLDivElement } = {};
    render(<Probe total={100} playhead={0} out={out} />);
    act(() => {
      for (let i = 0; i < 50; i++)
        out.el!.dispatchEvent(new WheelEvent("wheel", { deltaY: -3, ctrlKey: true, clientX: 10, bubbles: true, cancelable: true }));
    });
    expect(out.view!.zoom).toBeGreaterThan(1.5);
  });
});

// ── the editor ───────────────────────────────────────────────────────────────

function mount() {
  return render(
    <I18nProvider locale="en">
      <button type="button">app chrome button</button>
      <a href="#x">app chrome link</a>
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
const setPlayhead = (v: string) => fireEvent.change(playhead(), { target: { value: v } });

describe("the shortcuts dialog is a real modal", () => {
  async function open() {
    mount();
    fireEvent.click(screen.getByRole("button", { name: tv.shortcuts }));
    const dlg = screen.getByRole("dialog", { name: tv.shortcutsTitle });
    return dlg;
  }

  it("focus dropping to <body> (a click on plain text) comes back into the dialog, so Escape still closes it", async () => {
    const dlg = await open();
    const text = within(dlg).getByText(tv.shortcutsNote);
    // a mouse press on plain text keeps focus inside (the press is not left to move it to <body>)
    const notPrevented = fireEvent.mouseDown(text);
    expect(notPrevented).toBe(false);
    expect(dlg.contains(document.activeElement)).toBe(true);
    // and if focus is lost anyway, it is pulled back
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    await waitFor(() => expect(dlg.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Space, S and Delete never act on the timeline behind the open dialog, even with focus on <body>", async () => {
    mount();
    setPlayhead("4");
    fireEvent.click(screen.getByRole("button", { name: tv.shortcuts }));
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    key(" ");
    key("s");
    key("Delete");
    key("ArrowRight");
    key("+");
    expect(screen.getByRole("button", { name: te.play })).toBeTruthy();
    expect(clipButtons()).toHaveLength(1);
    expect(Number(playhead().value)).toBe(4);
    expect(zoomText(/100%$/)).toBeTruthy();
  });
});

describe("the single-key shortcuts belong to the editor", () => {
  it("do nothing with focus on the app's own buttons and links outside the editor", () => {
    mount();
    setPlayhead("4");
    for (const el of [screen.getByRole("button", { name: "app chrome button" }), screen.getByRole("link", { name: "app chrome link" })]) {
      el.focus();
      key("s", {}, el);
      key("Delete", {}, el);
      key("Backspace", {}, el);
      key("ArrowRight", {}, el);
      key("+", {}, el);
    }
    expect(clipButtons()).toHaveLength(1);
    expect(Number(playhead().value)).toBe(4);
    expect(zoomText(/100%$/)).toBeTruthy();
    // but on <body> and inside the editor they work
    key("s");
    expect(clipButtons()).toHaveLength(2);
  });

  it("Space with focus on the playhead slider is left to the slider", () => {
    mount();
    playhead().focus();
    const ev = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    playhead().dispatchEvent(ev);
    expect(screen.getByRole("button", { name: te.play })).toBeTruthy();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("S and 0 work from a Cyrillic layout (the physical keys)", () => {
    mount();
    setPlayhead("4");
    key("ы", { code: "KeyS" });
    expect(clipButtons()).toHaveLength(2);
    key("+");
    expect(zoomText(/150%$/)).toBeTruthy();
    key("à", { code: "Digit0" });
    expect(zoomText(/100%$/)).toBeTruthy();
  });
});

describe("S cuts the clip under the playhead, not a stale selection", () => {
  it("with clip 1 still selected and the playhead inside clip 2, S splits clip 2", () => {
    mount();
    setPlayhead("4");
    key("s"); // clips: 0-4, 4-10
    expect(clipButtons()).toHaveLength(2);
    fireEvent.click(clipButtons()[0]); // clip 1 is the selection
    setPlayhead("7");
    key("s");
    expect(clipButtons()).toHaveLength(3);
    expect(clipButtons()[1].getAttribute("aria-label")).toContain("0:03.0");
    expect(clipButtons()[2].getAttribute("aria-label")).toContain("0:03.0");
    expect(clipButtons()[0].getAttribute("aria-label")).toContain("0:04.0");
  });
});

describe("dragging the playhead slider", () => {
  function sized() {
    mount();
    setPlayhead("4");
    key("s"); // an edge at 4 s
    const input = playhead();
    // 1000px for 10 s = 100 px/s: 8px = 0.08 s
    input.getBoundingClientRect = () => ({ width: 1000, height: 16, x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 16, toJSON: () => ({}) });
    return input;
  }
  it("a pointer drag snaps to a clip edge; a key press never does", () => {
    const input = sized();
    fireEvent.change(input, { target: { value: "4.05" } });
    expect(Number(playhead().value)).toBeCloseTo(4.05, 2);
    fireEvent.pointerDown(input, { pointerType: "mouse" });
    fireEvent.change(input, { target: { value: "4.04" } });
    expect(Number(playhead().value)).toBe(4);
    fireEvent.pointerUp(window);
  });
  it("a release that happens outside the slider (or is lost) ends the snapping", () => {
    const input = sized();
    fireEvent.pointerDown(input, { pointerType: "mouse" });
    fireEvent.pointerUp(window); // released elsewhere: only the window hears it
    fireEvent.change(input, { target: { value: "4.05" } });
    expect(Number(playhead().value)).toBeCloseTo(4.05, 2);
    // and a blur ends it too
    fireEvent.pointerDown(input, { pointerType: "mouse" });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "4.06" } });
    expect(Number(playhead().value)).toBeCloseTo(4.06, 2);
  });
  it("on a long project the snap distance is capped in seconds", () => {
    const input = sized();
    input.getBoundingClientRect = () => ({ width: 10, height: 16, x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 16, toJSON: () => ({}) }); // 1 px/s
    fireEvent.pointerDown(input, { pointerType: "mouse" });
    fireEvent.change(input, { target: { value: "4.6" } });
    expect(Number(playhead().value)).toBeCloseTo(4.6, 2);
    fireEvent.pointerUp(window);
  });
});

describe("the zoom label does not flood screen readers", () => {
  it("the visible label is not a live region; one debounced, hidden announcement follows the zoom", () => {
    vi.useFakeTimers();
    try {
      mount();
      const label = zoomText(/%$/);
      expect(label.closest("[aria-live]")).toBeNull();
      const live = () => document.querySelector("div.sr-only[aria-live=polite]")!;
      expect(live().textContent).toBe("");
      fireEvent.click(screen.getByRole("button", { name: tv.zoomIn }));
      fireEvent.click(screen.getByRole("button", { name: tv.zoomIn }));
      expect(live().textContent).toBe("");
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(live().textContent).toBe("Zoom 225%");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a focused slider owns every key", () => {
  it("Delete, Backspace, S, + - 0 with focus on the playhead slider or a trim handle change nothing", () => {
    mount();
    setPlayhead("4");
    key("s"); // two clips; clip 1 is selected, so it shows trim handles
    expect(clipButtons()).toHaveLength(2);
    const handle = screen.getAllByRole("slider").find((el) => /clip 1/i.test(el.getAttribute("aria-label") ?? ""))!;
    for (const el of [playhead(), handle]) {
      el.focus();
      for (const k of ["Delete", "Backspace", "s", "+", "-", "0", "="]) key(k, {}, el);
    }
    expect(clipButtons()).toHaveLength(2);
    expect(zoomText(/100%$/)).toBeTruthy();
  });
});
