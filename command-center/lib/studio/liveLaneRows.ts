/**
 * A live film's lane (lib/studio/liveLane.ts) as the rows the timeline strip draws (components/studio-canvas/LaneStrip). Pure and
 * client-safe: the words come in as arguments, so tests/live-lane-rows.test.ts holds every rule without a browser.
 *
 * Rule 5 is the reason for most of this file: a piece is "made" only when its file landed, an unknown state is "unknown" in words
 * (never done), a length keeps its basis all the way to the pill, and the master is "ready" only with a file to download.
 */
import type { LaneLength, LaneRow, LaneTone } from "@/lib/studio/lane";
import { landedSince, type LanePiece, type LiveLane, type MasterPiece, type PieceState } from "@/lib/studio/liveLane";

export interface LaneRowWords {
  /** "Scene {n} · clip" for a one-shot scene. */
  clip: string;
  /** "Scene {n} · shot {k}" when a scene has more than one shot. */
  shot: string;
  voice: string;
  master: string;
  state: Record<PieceState, string>;
  /** "{state}: {reason}" for a failed piece. */
  failedWith: string;
  /** A stored error word as a sentence (the live view's own failure words). */
  failure: (code: string | null) => string;
  fmt: (s: string, v: Record<string, string | number>) => string;
}

const TONE: Record<PieceState, LaneTone> = {
  landed: "ok",
  working: "run",
  pending: "idle",
  // Waiting on its second attempt: not running yet, and not fine either.
  retried: "warn",
  failed: "fail",
  skipped: "idle",
  unknown: "warn",
};

export const pieceTone = (state: PieceState): LaneTone => TONE[state];

/** A piece's length on the strip, keeping its basis. The one place a basis is turned into what the strip draws. */
export function pieceLength(p: Pick<LanePiece, "length" | "lengthBasis">): LaneLength {
  if (p.length === null || !Number.isFinite(p.length) || p.length < 0 || p.lengthBasis === null) return null;
  return { seconds: p.length, basis: p.lengthBasis };
}

export function pieceWords(p: Pick<LanePiece, "state" | "error">, w: LaneRowWords): string {
  const word = w.state[p.state] ?? w.state.unknown;
  return p.state === "failed" ? w.fmt(w.failedWith, { state: word, reason: w.failure(p.error) }) : word;
}

function nameOf(p: LanePiece, shotsInScene: number, w: LaneRowWords): string {
  if (p.track === "video") return shotsInScene > 1 ? w.fmt(w.shot, { n: p.scene, k: p.shot }) : w.fmt(w.clip, { n: p.scene });
  return p.track === "audio" ? w.voice : w.master;
}

function rowOf(p: LanePiece, shotsInScene: number, w: LaneRowWords, thumbs: ReadonlyMap<string, string | null>): LaneRow {
  const made = p.state === "landed" && p.assetId !== null;
  return {
    id: p.id,
    track: p.track === "audio" ? "audio" : "video",
    name: nameOf(p, shotsInScene, w),
    tag: p.tag,
    // "landed" without a file cannot happen in liveLane; if it ever did, it is not drawn as done.
    status: p.state === "landed" && !made ? "warn" : pieceTone(p.state),
    statusWords: p.state === "landed" && !made ? w.state.unknown : pieceWords(p, w),
    length: pieceLength(p),
    // Only a landed piece's own picture: never a neighbour's, never a placeholder.
    thumb: made && p.assetId ? (thumbs.get(p.assetId) ?? null) : null,
    made,
  };
}

/** The video and audio pieces as rows, in play order (liveLane's order). The master is `masterRow`'s. */
export function laneRows(lane: LiveLane, w: LaneRowWords, thumbs: ReadonlyMap<string, string | null> = new Map()): LaneRow[] {
  const shots = new Map<string, number>();
  for (const p of lane.video) shots.set(p.sceneId, (shots.get(p.sceneId) ?? 0) + 1);
  return [...lane.video.map((p) => rowOf(p, shots.get(p.sceneId) ?? 1, w, thumbs)), ...lane.audio.map((p) => rowOf(p, 1, w, thumbs))];
}

/**
 * The master as the lane shows it. `ready` only with a recorded file; a landed master without one would be a "done" with nothing
 * to download, so it reads unknown.
 */
export type MasterCell =
  | { state: "ready"; assetId: string }
  | { state: "assembling" }
  | { state: "pending" }
  | { state: "failed"; reason: string | null }
  | { state: "skipped" }
  | { state: "unknown" };

export function masterCell(m: MasterPiece | null): MasterCell | null {
  if (!m) return null;
  switch (m.state) {
    case "landed":
      return m.assetId ? { state: "ready", assetId: m.assetId } : { state: "unknown" };
    case "working":
      return { state: "assembling" };
    case "pending":
    case "retried":
      return { state: "pending" };
    case "failed":
      return { state: "failed", reason: m.error };
    case "skipped":
      return { state: "skipped" };
    default:
      return { state: "unknown" };
  }
}

export interface AssemblyReasonWords {
  reasons: Record<string, string>;
  generic: string;
  remedy: string;
}

/**
 * Why an assembly failed, in words, with what to do. The stored reason (films.pause_reason) is a code and is never shown: a word the
 * contract names (docs/studio/NIGHTSHIFT_AI.md, "Where an assembly failure shows") gets its sentence, any other the generic line. The
 * remedy is text only (rule 3): for now it is always to start the project again, until an assembly-only re-run exists.
 */
export function assemblyReasonText(reason: string | null, w: AssemblyReasonWords): { text: string; remedy: string } {
  const known = reason !== null && Object.prototype.hasOwnProperty.call(w.reasons, reason) ? w.reasons[reason] : null;
  return { text: known ?? w.generic, remedy: w.remedy };
}

export interface MasterWords {
  name: string;
  ready: string;
  assembling: string;
  pending: string;
  skipped: string;
  unknown: string;
  assembly: AssemblyReasonWords;
}

const MASTER_TONE: Record<MasterCell["state"], LaneTone> = { ready: "ok", assembling: "run", pending: "idle", failed: "fail", skipped: "idle", unknown: "warn" };

/** The strip's master slot. Its length is the file's, measured, or nothing: a master has no plan to stand in for it. */
export function masterRow(m: MasterPiece | null, w: MasterWords, thumb: string | null = null): LaneRow | null {
  const cell = masterCell(m);
  if (!m || !cell) return null;
  const ready = cell.state === "ready";
  return {
    id: m.id,
    track: "video",
    name: w.name,
    tag: m.tag,
    status: MASTER_TONE[cell.state],
    statusWords: cell.state === "failed" ? assemblyReasonText(cell.reason, w.assembly).text : w[cell.state],
    length: ready && m.lengthBasis === "measured" ? pieceLength(m) : null,
    thumb: ready ? thumb : null,
    made: ready,
  };
}

/** The ids that landed since the previous reading of the same film: the strip's flights. None on a first reading or a switch. */
export function flightIds(prev: LiveLane | null, next: LiveLane): string[] {
  return landedSince(prev, next).map((p) => p.id);
}

/**
 * How much footage has landed, for the transport clock: the landed video pieces' lengths. Null when any landed piece has no
 * length (a sum without it would be a smaller number, not a measurement); `measured` only when every one of them was measured.
 */
export function landedSeconds(lane: LiveLane): { seconds: number; measured: boolean } | null {
  let seconds = 0;
  let measured = true;
  for (const p of lane.video) {
    if (p.state !== "landed") continue;
    const len = pieceLength(p);
    if (!len) return null;
    seconds += len.seconds;
    if (len.basis !== "measured") measured = false;
  }
  return { seconds, measured };
}

