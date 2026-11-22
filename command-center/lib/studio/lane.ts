/**
 * The canvas's timeline lane (components/studio-canvas/CanvasLane): which cards are clips and which are voice, in what order,
 * and how long each one is as far as anything has measured. Pure and client-safe, so tests/studio-lane.test.ts holds every rule.
 *
 * The lane is a reading of the canvas, never a second copy of it: it has no state of its own, no table and no film behind it, and
 * nothing on it renders, exports or spends (CLAUDE.md rule 3). A wire added above is a segment added below; a wire taken away
 * takes the segment with it.
 *
 * Decisions, each for a reason a person would notice:
 * - Only cards that are part of a wired chain are on the lane. A card standing alone is an idea on the board, not yet a step of
 *   the video; the owner's words were "as cards get connected, the lane fills in". The lane says how many were left off (`loose`),
 *   so a card never silently goes missing.
 * - A clip that feeds another clip-making card (Image → Video into Edit · Upscale) is folded into it: an upscaled clip is that
 *   shot, better, and drawing both would put the same shot on the lane twice. Take the wire away and the first clip is back on
 *   its own. The same holds for a recording fed into a voice change.
 * - Order is the chain's: a card comes after everything that feeds it (a topological order of the wires), and between cards that
 *   are free at the same moment the one further left on the board goes first. The order cards were created in plays no part.
 * - A length is measured (the media worker's reading of the file), requested (the length the job was asked for, and labelled so),
 *   or unknown. Never invented: an unknown is drawn as unknown, at a default width that says so, not as a number.
 */
import { outputType, type CanvasNode, type CanvasState } from "./canvas";

export type LaneTrack = "video" | "audio";
export const LANE_TRACKS: readonly LaneTrack[] = ["video", "audio"];

export interface LaneModel {
  video: CanvasNode[];
  audio: CanvasNode[];
  /** Cards that put out a clip or a recording but have no wire, so they are not on the lane. */
  loose: CanvasNode[];
}

type Graph = Pick<CanvasState, "nodes" | "wires">;

const leftFirst = (a: CanvasNode, b: CanvasNode) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id);

/**
 * Every node once, in the chain's order: a node only after all that feed it; among nodes free at the same step, left to right.
 * A loop (canWire refuses one, but a stored layout is only checked as well as the code that wrote it) cannot hang this: whatever a
 * loop holds back is placed after the rest, left to right, once.
 */
export function chainOrder(state: Graph): CanvasNode[] {
  const ids = new Set(state.nodes.map((n) => n.id));
  const wires = state.wires.filter((w) => w.from !== w.to && ids.has(w.from) && ids.has(w.to));
  const waiting = new Map<string, number>(state.nodes.map((n) => [n.id, 0]));
  for (const w of wires) waiting.set(w.to, (waiting.get(w.to) ?? 0) + 1);
  const ready = state.nodes.filter((n) => waiting.get(n.id) === 0);
  const out: CanvasNode[] = [];
  const placed = new Set<string>();
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  while (ready.length) {
    ready.sort(leftFirst);
    const n = ready.shift()!;
    if (placed.has(n.id)) continue;
    placed.add(n.id);
    out.push(n);
    for (const w of wires) {
      if (w.from !== n.id) continue;
      const left = (waiting.get(w.to) ?? 0) - 1;
      waiting.set(w.to, left);
      if (left === 0 && !placed.has(w.to)) ready.push(byId.get(w.to)!);
    }
  }
  const stuck = state.nodes.filter((n) => !placed.has(n.id)).sort(leftFirst);
  return [...out, ...stuck];
}

/** Which track a node's output belongs on, or null (words, pictures, an Edit with nothing wired in yet). */
export function trackOf(state: Graph, node: CanvasNode): LaneTrack | null {
  const t = outputType(state, node);
  return t === "video" ? "video" : t === "audio" ? "audio" : null;
}

/** The lane: each track's segments in chain order, and the clip and voice cards left off it because nothing is wired to them. */
export function laneOf(state: Graph): LaneModel {
  const ids = new Set(state.nodes.map((n) => n.id));
  const wires = state.wires.filter((w) => w.from !== w.to && ids.has(w.from) && ids.has(w.to));
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  const wired = new Set(wires.flatMap((w) => [w.from, w.to]));
  const lane: LaneModel = { video: [], audio: [], loose: [] };
  for (const n of chainOrder(state)) {
    const track = trackOf(state, n);
    if (!track) continue;
    if (!wired.has(n.id)) {
      lane.loose.push(n);
      continue;
    }
    // Folded into the card it feeds when that card makes the same kind of thing (an upscale of this clip, a voice change).
    const folded = wires.some((w) => w.from === n.id && trackOf(state, byId.get(w.to)!) === track);
    if (!folded) lane[track].push(n);
  }
  return lane;
}

// ── lengths ────────────────────────────────────────────────────────────────────

export type LaneLength = { seconds: number; basis: "measured" | "requested" } | null;

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v < 86_400;

/**
 * How long a segment is, and how we know. The file's measured length wins; a clip job's requested length (params.duration_s, what
 * the composer sent) is used only while that job has not failed, and is labelled "requested"; anything else is unknown (null).
 * A voice job asks for no length (its words decide it), so a voice segment is measured or unknown.
 */
export function segmentLength(input: { measured: number | null | undefined; requested: unknown; failed: boolean; track: LaneTrack }): LaneLength {
  if (positive(input.measured)) return { seconds: input.measured, basis: "measured" };
  if (input.track === "video" && !input.failed && positive(input.requested)) return { seconds: input.requested, basis: "requested" };
  return null;
}

export interface LaneTotal {
  /** The sum of every length that is known. */
  seconds: number;
  /** Some of that sum is only what was asked for. */
  requested: boolean;
  /** How many segments have no known length (not in the sum). */
  unknown: number;
}

export function laneTotal(lengths: readonly LaneLength[]): LaneTotal {
  let seconds = 0;
  let requested = false;
  let unknown = 0;
  for (const l of lengths) {
    if (!l) unknown += 1;
    else {
      seconds += l.seconds;
      if (l.basis === "requested") requested = true;
    }
  }
  return { seconds, requested, unknown };
}

// ── drawing on a time scale ─────────────────────────────────────────────────────

/** A segment with no known length is drawn this wide, hatched and marked "?", so it can never read as a measurement. */
export const UNKNOWN_W = 132;

export interface LanePlace {
  x: number;
  w: number;
  /** Is this segment's start a real time (everything before it on its track has a known length)? */
  timed: boolean;
}

/**
 * Where each segment of one track sits, left to right from 0, at `pxPerS` pixels a second. A known length is exactly to scale (no
 * minimum width, no gap added: the gap between pills is drawn inside each one, so the ruler above stays true); an unknown one takes
 * UNKNOWN_W. From the first unknown on, a start is no longer a time: `timed` turns false and `timedUntil` says where that began.
 */
export function placeTrack(lengths: readonly LaneLength[], pxPerS: number): { places: LanePlace[]; end: number; timedUntil: number } {
  const places: LanePlace[] = [];
  let x = 0;
  let timedUntil = Infinity;
  for (const l of lengths) {
    const w = l ? l.seconds * pxPerS : UNKNOWN_W;
    places.push({ x, w, timed: timedUntil === Infinity });
    if (!l && timedUntil === Infinity) timedUntil = x;
    x += w;
  }
  return { places, end: x, timedUntil };
}
