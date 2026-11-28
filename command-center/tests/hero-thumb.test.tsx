// @vitest-environment jsdom
/**
 * The idea bar's thumbnail (components/landing/home/HeroThumb.tsx). What would break without these: the owner's complaint of
 * 2026-11-22 coming back (the bar holding the orbit still while the clip behind it had reached the night street); the thumbnail
 * drawing a second, unsynchronised picture; a loop that keeps painting while nothing moves (a paused clip, a hidden tab, an
 * off-screen bar, reduced motion); and a canvas whose pixels are read back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HeroThumb, THUMB_FRAME_MS, coverRect } from "@/components/landing/home/HeroThumb";
import { setMotionPaused } from "@/lib/site/motion";

const STILL = "/hero-poster-sm.webp";

type Ctx = { drawImage: ReturnType<typeof vi.fn>; getImageData: ReturnType<typeof vi.fn> };
let ctx: Ctx;
let getContext: ReturnType<typeof vi.fn>;
let readBack: ReturnType<typeof vi.fn>;

/** The hero as LoopClip leaves it: a box with the hero's id, and (once the clip is allowed) one <video> in it. */
function Hero() {
  return (
    <>
      <div id="sample-hero" className="hm-hero-media" data-clip="sample" aria-hidden="true" />
      <HeroThumb still={STILL} mirror="sample-hero" />
    </>
  );
}

function fakeVideo({ paused = false } = {}) {
  const v = document.createElement("video");
  let p = paused;
  Object.defineProperty(v, "paused", { get: () => p, configurable: true });
  Object.defineProperty(v, "readyState", { value: 4, configurable: true });
  Object.defineProperty(v, "videoWidth", { value: 1280, configurable: true });
  Object.defineProperty(v, "videoHeight", { value: 720, configurable: true });
  return {
    v,
    play() {
      p = false;
      v.dispatchEvent(new Event("playing"));
    },
    pause() {
      p = true;
      v.dispatchEvent(new Event("pause"));
    },
  };
}

/** LoopClip mounting its video and the clip starting: the video arrives, plays, and the box says it is live. */
async function startClip(opts?: { paused?: boolean }) {
  const box = document.getElementById("sample-hero")!;
  const clip = fakeVideo(opts);
  await act(async () => {
    box.appendChild(clip.v);
    await Promise.resolve();
  });
  await act(async () => {
    if (!opts?.paused) {
      box.setAttribute("data-live", "true");
      clip.play();
    }
    await Promise.resolve();
  });
  return { box, clip };
}

const thumb = (c: HTMLElement) => c.querySelector(".hm-idea-thumb") as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  ctx = { drawImage: vi.fn(), getImageData: vi.fn() };
  getContext = vi.fn(() => ctx);
  readBack = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(getContext as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(readBack as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(readBack as never);
});

afterEach(() => {
  cleanup();
  act(() => setMotionPaused(false));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Nothing is ever read back from the canvas, in any test.
  expect(ctx.getImageData).not.toHaveBeenCalled();
  expect(readBack).not.toHaveBeenCalled();
});

describe("the idea bar's thumbnail shows the hero's own picture", () => {
  it("before the clip, and with no clip at all, is the hero's still and draws nothing", async () => {
    const { container } = render(<Hero />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(THUMB_FRAME_MS * 10);
    });
    expect(thumb(container).style.backgroundImage).toBe(`url("${STILL}")`);
    expect(thumb(container).hasAttribute("data-live")).toBe(false);
    expect(getContext).not.toHaveBeenCalled();
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  it("draws the hero's own <video> element, cover-fit at the hero's crop, at about 14 frames a second, and shows it", async () => {
    const { container } = render(<Hero />);
    const { clip } = await startClip();
    // The first frame at once, then one every THUMB_FRAME_MS.
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    const [source, ...rect] = ctx.drawImage.mock.calls[0];
    expect(source).toBe(clip.v);
    expect(rect).toEqual([...coverRect(1280, 720, 160, 100), 0, 0, 160, 100]);
    expect(thumb(container).getAttribute("data-live")).toBe("true");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const perSecond = ctx.drawImage.mock.calls.length - 1;
    expect(perSecond).toBeGreaterThanOrEqual(12);
    expect(perSecond).toBeLessThanOrEqual(15);
    for (const call of ctx.drawImage.mock.calls) expect(call[0]).toBe(clip.v);
  });

  it("draws nothing while the clip is paused, and keeps the frame it stopped on (as the hero does)", async () => {
    const { container } = render(<Hero />);
    const { clip } = await startClip();
    await act(async () => {
      clip.pause();
      await Promise.resolve();
    });
    const at = ctx.drawImage.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(THUMB_FRAME_MS * 20);
    });
    expect(ctx.drawImage).toHaveBeenCalledTimes(at);
    // A hold keeps the hero's frame (LoopClip leaves data-live), so the thumbnail keeps its copy of that frame too.
    expect(thumb(container).getAttribute("data-live")).toBe("true");
    await act(async () => {
      clip.play();
      await vi.advanceTimersByTimeAsync(THUMB_FRAME_MS * 3);
    });
    expect(ctx.drawImage.mock.calls.length).toBeGreaterThan(at);
  });

  it("draws nothing for a clip that never started playing", async () => {
    render(<Hero />);
    await startClip({ paused: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(THUMB_FRAME_MS * 20);
    });
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  it("stops at once when the page's pause switch is pressed, before the clip itself has stopped", async () => {
    render(<Hero />);
    await startClip();
    act(() => setMotionPaused(true));
    const at = ctx.drawImage.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(THUMB_FRAME_MS * 20);
    });
    expect(ctx.drawImage).toHaveBeenCalledTimes(at);
  });

  it("draws nothing in a hidden tab", async () => {
    render(<Hero />);
    await startClip();
    const state = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const at = ctx.drawImage.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(THUMB_FRAME_MS * 20);
    });
    expect(ctx.drawImage).toHaveBeenCalledTimes(at);
    state.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(THUMB_FRAME_MS * 3);
    });
    expect(ctx.drawImage.mock.calls.length).toBeGreaterThan(at);
  });

  it("draws nothing while the bar is off screen", async () => {
    let report: (on: boolean) => void = () => undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (e: Array<Partial<IntersectionObserverEntry>>) => void) {
          report = (on) => cb([{ isIntersecting: on }]);
        }
        observe() {}
        disconnect() {}
      },
    );
    render(<Hero />);
    await startClip();
    // Until the observer has spoken the bar is not known to be on screen: nothing yet.
    expect(ctx.drawImage).not.toHaveBeenCalled();
    act(() => report(true));
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    act(() => report(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(THUMB_FRAME_MS * 20);
    });
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
  });

  it("under reduced motion never draws, even if a video were there: the still is the whole picture", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
    const { container } = render(<Hero />);
    await startClip();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(THUMB_FRAME_MS * 20);
    });
    expect(getContext).not.toHaveBeenCalled();
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(thumb(container).hasAttribute("data-live")).toBe(false);
    expect(thumb(container).style.backgroundImage).toBe(`url("${STILL}")`);
  });

  it("goes back to the still when the hero does (a stall, off screen), and stops drawing", async () => {
    const { container } = render(<Hero />);
    const { box } = await startClip();
    await act(async () => {
      box.removeAttribute("data-live");
      await Promise.resolve();
    });
    expect(thumb(container).hasAttribute("data-live")).toBe(false);
    const at = ctx.drawImage.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(THUMB_FRAME_MS * 20);
    });
    expect(ctx.drawImage).toHaveBeenCalledTimes(at);
  });

  it("stops drawing when it unmounts", async () => {
    const { unmount } = render(<Hero />);
    await startClip();
    unmount();
    const at = ctx.drawImage.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(THUMB_FRAME_MS * 20);
    });
    expect(ctx.drawImage).toHaveBeenCalledTimes(at);
  });

  it("crops like the hero's object-fit: cover at its object-position, never stretched", () => {
    // 16:9 into the 80 x 50 pill (x2): the full height, a 1152-wide window placed 70% of the way across the spare width.
    const [sx, sy, sw, sh] = coverRect(1280, 720, 160, 100, "70% 55%");
    expect(sw / sh).toBeCloseTo(160 / 100, 6);
    expect(sh).toBeCloseTo(720, 6);
    expect(sx).toBeCloseTo((1280 - 1152) * 0.7, 6);
    expect(sy).toBeCloseTo(0, 6);
    // A tall frame into the same pill: the full width, cut top and bottom.
    const [, ty, tw, th] = coverRect(720, 1280, 160, 100);
    expect(tw).toBeCloseTo(720, 6);
    expect(ty).toBeCloseTo((1280 - th) / 2, 6);
  });

  it("never reads pixels back and never makes a second video: only drawImage of the hero's own element", () => {
    const src = readFileSync(path.join(__dirname, "../components/landing/home/HeroThumb.tsx"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/getImageData|toDataURL|toBlob|readPixels|captureStream|createImageBitmap/);
    expect(code).not.toMatch(/<video|createElement\(\s*["']video/);
    expect(code).toMatch(/\.drawImage\(/);
  });
});
