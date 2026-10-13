import { describe, expect, it } from "vitest";
import {
  MAX_PX_PER_S,
  SNAP_MAX_S,
  SNAP_PX,
  ZOOM_CEIL,
  ZOOM_FIT,
  ZOOM_FLOOR_MAX,
  anchoredScrollLeft,
  clampZoom,
  contentWidth,
  maxZoom,
  nudgePlayhead,
  scrollToReveal,
  snapPlayhead,
  snapTargets,
  snapThresholdS,
  snapTime,
  snapTrimValue,
  stepZoom,
  wheelZoom,
} from "@/lib/editor-timeline-view";
import type { SoundClip, TextClip, VideoClip } from "@/lib/editor";

const clip = (id: string, start_s: number, len: number, speed = 1): VideoClip =>
  ({ id, asset_id: "a", start_s, in_s: 0, out_s: len * speed, speed, audio: true }) as unknown as VideoClip;
const text = (id: string, a: number, b: number): TextClip => ({ id, start_s: a, end_s: b }) as unknown as TextClip;
const sound = (id: string, start_s: number, len: number): SoundClip =>
  ({ id, asset_id: "m", start_s, in_s: 0, out_s: len }) as unknown as SoundClip;

describe("zoom", () => {
  it("fit is zoom 1 and zoom never goes below it", () => {
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(NaN)).toBe(1);
    expect(stepZoom(1, -1)).toBe(1);
    expect(contentWidth(300, 1)).toBe(300);
    expect(contentWidth(300, 2.5)).toBe(750);
    expect(contentWidth(300, 0.1)).toBe(300);
  });
  it("steps by 1.5x, lands exactly on fit when it gets close, and stops at the ceiling", () => {
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(1.5, 1)).toBe(2.25);
    expect(stepZoom(1.5, -1)).toBe(1);
    expect(stepZoom(2.25, -1)).toBe(1.5);
    expect(stepZoom(7, 1, 8)).toBe(8);
    expect(stepZoom(8, 1, 8)).toBe(8);
  });
  it("the ceiling grows with the project's length but has a floor and a cap", () => {
    expect(maxZoom(3, 320)).toBe(ZOOM_FLOOR_MAX);
    expect(maxZoom(600, 320)).toBe(Math.min(ZOOM_CEIL, (MAX_PX_PER_S * 600) / 320));
    expect(maxZoom(4 * 3600, 320)).toBe(ZOOM_CEIL);
    expect(maxZoom(0, 320)).toBe(ZOOM_FLOOR_MAX);
    expect(maxZoom(10, 0)).toBe(ZOOM_FLOOR_MAX);
  });
  it("the wheel zooms in when scrolling up and out when scrolling down, smoothly and bounded", () => {
    expect(wheelZoom(2, -100, 0)).toBeGreaterThan(2);
    expect(wheelZoom(2, 100, 0)).toBeLessThan(2);
    expect(wheelZoom(1, 100, 0)).toBe(ZOOM_FIT);
    expect(wheelZoom(2, -100000, 0, 8)).toBeLessThanOrEqual(8);
    // one huge delta cannot jump more than one capped notch
    expect(wheelZoom(2, -100000, 0)).toBeCloseTo(wheelZoom(2, -240, 0), 6);
    // a line-mode wheel (Firefox) counts more per notch than a pixel one
    expect(wheelZoom(2, -3, 1)).toBeGreaterThan(wheelZoom(2, -3, 0));
    expect(wheelZoom(2, NaN, 0)).toBe(2);
  });
  it("slow wheel or pinch deltas from fit accumulate and leave fit (they never stick at 100%)", () => {
    let z = ZOOM_FIT;
    for (let i = 0; i < 50; i++) z = wheelZoom(z, -3, 0);
    expect(z).toBeGreaterThan(1.5);
    // one tiny event from fit already moves
    expect(wheelZoom(1, -3, 0)).toBeGreaterThan(1);
    // zooming OUT near fit still lands exactly on fit
    expect(wheelZoom(1.01, 5, 0)).toBe(ZOOM_FIT);
    expect(wheelZoom(1.5, 400, 0)).toBe(ZOOM_FIT);
  });
});

describe("scroll anchoring", () => {
  it("keeps the point under the anchor where it was", () => {
    // a 300px window over a 600px strip, scrolled 150; the point 100px from the left is at content x 250 (fraction 5/12)
    const next = anchoredScrollLeft({ scrollLeft: 150, anchorX: 100, prevWidth: 600, nextWidth: 1200 });
    expect(next + 100).toBeCloseTo((250 / 600) * 1200, 6);
  });
  it("is never negative and survives an empty strip", () => {
    expect(anchoredScrollLeft({ scrollLeft: 0, anchorX: 200, prevWidth: 600, nextWidth: 300 })).toBe(0);
    expect(anchoredScrollLeft({ scrollLeft: 5, anchorX: 0, prevWidth: 0, nextWidth: 300 })).toBe(0);
  });
  it("reveals a point outside the window and leaves a visible one alone", () => {
    const base = { viewportPx: 300, contentPx: 1200 };
    expect(scrollToReveal({ ...base, scrollLeft: 100, x: 200 })).toBe(100);
    expect(scrollToReveal({ ...base, scrollLeft: 0, x: 500 })).toBe(500 - 300 + 24);
    expect(scrollToReveal({ ...base, scrollLeft: 600, x: 100 })).toBe(100 - 24);
    expect(scrollToReveal({ ...base, scrollLeft: 0, x: 1200 })).toBe(900);
    expect(scrollToReveal({ ...base, scrollLeft: 0, x: -50 })).toBe(0);
  });
});

describe("playhead step", () => {
  it("moves a frame, or a second with big, on the frame grid and inside the project", () => {
    expect(nudgePlayhead({ playhead: 1, dir: 1, fps: 30, total: 10 })).toBeCloseTo(1 + 1 / 30, 3);
    expect(nudgePlayhead({ playhead: 1, dir: -1, fps: 30, total: 10 })).toBeCloseTo(1 - 1 / 30, 3);
    expect(nudgePlayhead({ playhead: 1, dir: 1, fps: 30, total: 10, big: true })).toBe(2);
    expect(nudgePlayhead({ playhead: 0, dir: -1, fps: 30, total: 10 })).toBe(0);
    expect(nudgePlayhead({ playhead: 9.99, dir: 1, fps: 30, total: 10, big: true })).toBe(10);
    // an off-grid playhead (a text edge) lands back on a frame
    const n = nudgePlayhead({ playhead: 1.012, dir: 1, fps: 30, total: 10 });
    expect(Math.round(n * 30) / 30).toBeCloseTo(n, 3);
    expect(nudgePlayhead({ playhead: 1, dir: 1, fps: 0, total: 10 })).toBeCloseTo(1 + 1 / 30, 3);
  });
});

describe("snapping", () => {
  const clips = [clip("c1", 0, 3), clip("c2", 3, 4), clip("c3", 7, 2)];
  it("collects 0, the playhead and every clip, text and sound edge, sorted without duplicates", () => {
    const t = snapTargets({ clips, texts: [text("x", 1, 2.5)], sounds: [sound("m", 0.5, 4)], playhead: 5 });
    expect(t).toEqual([0, 0.5, 1, 2.5, 3, 4.5, 5, 7, 9]);
  });
  it("leaves out the clips after the one being trimmed (they ripple)", () => {
    const t = snapTargets({ clips, texts: [], sounds: [], playhead: 8, skipClipsAfter: "c2" });
    expect(t).toEqual([0, 3, 7, 8]);
  });
  it("snaps to the nearest target inside the threshold, else stays free", () => {
    const targets = [0, 3, 3.2, 7];
    expect(snapTime(3.15, targets, 0.1)).toEqual({ time: 3.2, snappedTo: 3.2 });
    expect(snapTime(5, targets, 0.1)).toEqual({ time: 5, snappedTo: null });
    expect(snapTime(5, [], 1)).toEqual({ time: 5, snappedTo: null });
  });
  it("the threshold is a number of screen pixels, so it shrinks as you zoom in", () => {
    expect(snapThresholdS(100)).toBeCloseTo(SNAP_PX / 100, 6);
    expect(snapThresholdS(400)).toBeLessThan(snapThresholdS(100));
    expect(snapThresholdS(100, true)).toBeGreaterThan(snapThresholdS(100));
    expect(snapThresholdS(0)).toBe(0);
  });
  it("never snaps from further than SNAP_MAX_S, however few pixels a second there are", () => {
    expect(snapThresholdS(1)).toBe(SNAP_MAX_S);
    expect(snapThresholdS(0.1, true)).toBe(SNAP_MAX_S);
    // a 600 s project in a 300 px slider: 0.5 px/s, the playhead is still placed freely
    const src = { clips: [clip("c1", 0, 300), clip("c2", 300, 300)], texts: [], sounds: [] };
    expect(snapPlayhead(302, src, 0.5, true)).toBe(302);
    expect(snapPlayhead(300.2, src, 0.5, true)).toBe(300);
  });
  it("a trim drag snaps the pointer's time to a target and converts back to source seconds", () => {
    // out handle of a 2x clip ending at timeline 4 (source out 8): pointer 12px right at 100 px/s is 4.12s
    const base = { edge: "out" as const, v0: 8, speed: 2, baseTime: 4, pxPerS: 100, targets: [4.1], snap: true };
    const near = snapTrimValue({ ...base, dx: 12 });
    expect(near.snappedTo).toBe(4.1);
    expect(near.value).toBeCloseTo(8 + 0.1 * 2, 9);
    const free = snapTrimValue({ ...base, dx: 40 });
    expect(free.snappedTo).toBeNull();
    expect(free.value).toBeCloseTo(8 + 0.4 * 2, 9);
    const off = snapTrimValue({ ...base, dx: 12, snap: false });
    expect(off.snappedTo).toBeNull();
    expect(off.value).toBeCloseTo(8 + 0.12 * 2, 9);
    // dragging left works the same way
    expect(snapTrimValue({ ...base, targets: [3.9], dx: -12 }).value).toBeCloseTo(8 - 0.1 * 2, 9);
  });
  it("the in handle snaps the clip's END (the edge that moves), not the pointer", () => {
    // clip of source 0..6 at 2x ends at timeline 3; dragging the in handle 90px right at 100 px/s shrinks it by 0.9s,
    // so its end moves to 2.1; a target at 2.05 is within 8px of that END and the in point follows: 0 + (3 - 2.05) * 2
    const base = { edge: "in" as const, v0: 0, speed: 2, baseTime: 3, pxPerS: 100, snap: true };
    const near = snapTrimValue({ ...base, dx: 90, targets: [2.05] });
    expect(near.snappedTo).toBe(2.05);
    expect(near.value).toBeCloseTo((3 - 2.05) * 2, 9);
    // a target at the POINTER's time (start + dx) is not a snap for the in handle
    expect(snapTrimValue({ ...base, dx: 90, targets: [0.9] }).snappedTo).toBeNull();
    const free = snapTrimValue({ ...base, dx: 90, targets: [] });
    expect(free.value).toBeCloseTo(0.9 * 2, 9);
    expect(snapTrimValue({ ...base, dx: 90, targets: [2.05], snap: false }).value).toBeCloseTo(0.9 * 2, 9);
  });
  it("the playhead drag snaps to clip edges only when snapping is on", () => {
    const src = { clips, texts: [], sounds: [] };
    expect(snapPlayhead(3.05, src, 100, true)).toBe(3);
    expect(snapPlayhead(3.05, src, 100, false)).toBe(3.05);
    expect(snapPlayhead(5, src, 100, true)).toBe(5);
  });
});
