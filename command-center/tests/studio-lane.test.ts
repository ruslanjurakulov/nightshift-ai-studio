/**
 * The canvas's timeline lane, the pure part (lib/studio/lane.ts). Each test names what a person would see go wrong without it:
 * clips in the order they were made instead of the order they are wired; a voice-over drawn as a clip; a segment that stays after
 * its wire is gone; a stored loop that freezes the tab; the same shot on the lane twice; a guessed length drawn as a measured one.
 */
import { describe, expect, it } from "vitest";
import { EMPTY_STATE, connect, disconnect, newNode, type CanvasNode, type CanvasState, type CanvasWire } from "@/lib/studio/canvas";
import { chainOrder, laneOf, laneTotal, placeTrack, segmentLength, UNKNOWN_W } from "@/lib/studio/lane";

const state = (nodes: CanvasNode[], wires: [string, string][] = []): CanvasState => {
  let s: CanvasState = { ...EMPTY_STATE, nodes };
  wires.forEach(([from, to], i) => (s = connect(s, from, to, `w${i}`)));
  return s;
};
const ids = (list: readonly CanvasNode[]) => list.map((n) => n.id);

describe("order follows the wires", () => {
  it("not the order cards were created in, and not their x alone: a clip waits for the picture it is made from", () => {
    // Created first, placed furthest left, but its picture is further right: it comes after a clip whose words are free sooner.
    const late = newNode("animate", 100, 0, "late");
    const pic = newNode("image", 800, 0, "pic");
    const words = newNode("prompt", 0, 0, "words");
    const clip = newNode("video", 500, 300, "clip");
    const s = state([late, pic, words, clip], [
      ["words", "pic"],
      ["pic", "late"],
      ["words", "clip"],
    ]);
    expect(ids(laneOf(s).video)).toEqual(["clip", "late"]);
  });

  it("between cards free at the same step, the one further left goes first", () => {
    const a = newNode("prompt", 0, 0, "a");
    const b = newNode("prompt", 0, 400, "b");
    const right = newNode("video", 900, 0, "right");
    const left = newNode("video", 300, 400, "left");
    const s = state([right, a, left, b], [
      ["a", "right"],
      ["b", "left"],
    ]);
    expect(ids(laneOf(s).video)).toEqual(["left", "right"]);
  });
});

describe("tracks", () => {
  it("a voice card lands on the audio track, never on video, even when it is fed a clip (a dub)", () => {
    const words = newNode("prompt", 0, 0, "words");
    const clip = newNode("video", 300, 0, "clip");
    const dub = newNode("voice", 600, 0, "dub");
    const s = state([words, clip, dub], [
      ["words", "clip"],
      ["clip", "dub"],
    ]);
    const lane = laneOf(s);
    expect(ids(lane.video)).toEqual(["clip"]);
    expect(ids(lane.audio)).toEqual(["dub"]);
  });

  it("words and pictures are not segments", () => {
    const s = state([newNode("prompt", 0, 0, "p"), newNode("image", 300, 0, "i")], [["p", "i"]]);
    expect(laneOf(s)).toEqual({ video: [], audio: [], loose: [] });
  });

  it("a library clip wired into a chain is a segment; an Edit is a clip only once a clip is wired into it", () => {
    const file = newNode("asset", 0, 0, "file", { assetId: "0c000000-0000-4000-8000-0000000000a5", assetKind: "video" });
    const voice = newNode("voice", 300, 0, "voice");
    const edit = newNode("enhance", 300, 300, "edit");
    const s = state([file, voice, edit], [["file", "voice"]]);
    expect(ids(laneOf(s).video)).toEqual(["file"]);
    expect(ids(laneOf(s).loose)).toEqual([]);
  });
});

describe("connecting and disconnecting", () => {
  it("a card with no wire is left off (and counted), and wiring it puts it on", () => {
    const words = newNode("prompt", 0, 0, "words");
    const clip = newNode("video", 300, 0, "clip");
    let s = state([words, clip]);
    expect(laneOf(s).video).toEqual([]);
    expect(ids(laneOf(s).loose)).toEqual(["clip"]);
    s = connect(s, "words", "clip", "w");
    expect(ids(laneOf(s).video)).toEqual(["clip"]);
    expect(laneOf(s).loose).toEqual([]);
  });

  it("taking the wire away takes the segment away", () => {
    const s = state([newNode("prompt", 0, 0, "words"), newNode("voice", 300, 0, "vo")], [["words", "vo"]]);
    expect(ids(laneOf(s).audio)).toEqual(["vo"]);
    const after = disconnect(s, "vo");
    expect(laneOf(after).audio).toEqual([]);
    expect(ids(laneOf(after).loose)).toEqual(["vo"]);
  });

  it("an upscale of a clip is that shot once, not twice; unwiring the upscale gives the clip its own segment back", () => {
    const words = newNode("prompt", 0, 0, "words");
    const clip = newNode("video", 300, 0, "clip");
    const up = newNode("enhance", 600, 0, "up");
    const s = state([words, clip, up], [
      ["words", "clip"],
      ["clip", "up"],
    ]);
    expect(ids(laneOf(s).video)).toEqual(["up"]);
    expect(ids(laneOf(disconnect(s, "up")).video)).toEqual(["clip"]);
  });
});

describe("a loop cannot hang the lane", () => {
  it("a stored layout with a cycle (wires written by hand, past canWire) still returns every node once", () => {
    const a = newNode("voice", 0, 0, "a");
    const b = newNode("voice", 300, 0, "b");
    const c = newNode("prompt", -300, 0, "c");
    const d = newNode("voice", 0, 300, "d");
    const wires: CanvasWire[] = [
      { id: "1", from: "a", to: "b" },
      { id: "2", from: "b", to: "a" },
      { id: "3", from: "c", to: "d" },
      { id: "4", from: "d", to: "d" },
      { id: "5", from: "gone", to: "a" },
    ];
    const s: CanvasState = { ...EMPTY_STATE, nodes: [a, b, c, d], wires };
    const order = chainOrder(s);
    expect(ids(order).sort()).toEqual(["a", "b", "c", "d"]);
    expect(ids(order).slice(0, 2)).toEqual(["c", "d"]);
    const lane = laneOf(s);
    expect(ids(lane.audio)).toEqual(["d"]);
  });
});

describe("lengths are measured, requested or unknown, never invented", () => {
  it("the file's measured length wins over what was asked for", () => {
    expect(segmentLength({ measured: 6.2, requested: 5, failed: false, track: "video" })).toEqual({ seconds: 6.2, basis: "measured" });
  });
  it("a clip's requested length is labelled requested; a failed clip has no length at all", () => {
    expect(segmentLength({ measured: null, requested: 5, failed: false, track: "video" })).toEqual({ seconds: 5, basis: "requested" });
    expect(segmentLength({ measured: null, requested: 5, failed: true, track: "video" })).toBeNull();
  });
  it("a voice is never given a requested length, and junk is unknown, not 0", () => {
    expect(segmentLength({ measured: null, requested: 5, failed: false, track: "audio" })).toBeNull();
    for (const v of [0, -1, Number.NaN, Infinity, "5", null, undefined]) {
      expect(segmentLength({ measured: v as number, requested: v, failed: false, track: "video" })).toBeNull();
    }
  });
  it("the total counts only what is known, says when part of it is requested, and how many are unknown", () => {
    expect(laneTotal([{ seconds: 6, basis: "measured" }, { seconds: 5, basis: "requested" }, null])).toEqual({ seconds: 11, requested: true, unknown: 1 });
    expect(laneTotal([])).toEqual({ seconds: 0, requested: false, unknown: 0 });
  });
});

describe("the time scale stays true", () => {
  it("known lengths are exactly to scale, so the ruler above them is right; from the first unknown on, starts are not times", () => {
    const { places, end, timedUntil } = placeTrack([{ seconds: 5, basis: "measured" }, null, { seconds: 2, basis: "requested" }], 20);
    expect(places).toEqual([
      { x: 0, w: 100, timed: true },
      { x: 100, w: UNKNOWN_W, timed: true },
      { x: 100 + UNKNOWN_W, w: 40, timed: false },
    ]);
    expect(timedUntil).toBe(100);
    expect(end).toBe(140 + UNKNOWN_W);
  });
  it("a track with no unknown is timed all the way", () => {
    expect(placeTrack([{ seconds: 1, basis: "measured" }], 10).timedUntil).toBe(Infinity);
  });
});
