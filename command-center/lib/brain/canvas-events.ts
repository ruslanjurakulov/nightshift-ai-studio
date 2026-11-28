import type { BrainPhase } from "@/lib/brain/stream-events";

/**
 * The browser events the Nightshift AI panel sends the canvas beside it (docs/studio/LIVE_CREATION_PLAN.md §3.1, §3.8). One helper
 * dispatches both, so the panel, and S3's canvas when it adopts this, name them once.
 *
 *   nightshift:brain-brief    the conversation's BRIEF changed on the server: the canvas reads it again (useBrainBrief);
 *   nightshift:brain-activity what the server is doing for this conversation right now, from the stream's real events only:
 *                             { session_id (null only for a first send's "thinking"), phase } (phase "end" once the answer arrived), with the plan's window counts while a
 *                             storyboard is written. Nothing here is a timer.
 *
 * Minimal on purpose: S3's own helper was not on main when this landed; the event names and detail shapes are the contract.
 */

export const BRAIN_BRIEF_EVENT = "nightshift:brain-brief";
export const BRAIN_ACTIVITY_EVENT = "nightshift:brain-activity";

/** While a storyboard is written: windows arrived of all, and chapters complete of all. */
export type BrainActivityPlan = { windows: number; of: number; chapters_written: number; chapters: number };

/**
 * What the server is doing for one conversation. session_id is null ONLY for "thinking" on a conversation's first send, before the
 * server has made the session (Atlas, 28 Nov): every other phase names a real session. No "" sentinel: an empty string reads as an id.
 */
export type BrainActivity =
  | { session_id: string; phase: BrainPhase | "end"; plan?: BrainActivityPlan }
  | { session_id: null; phase: "thinking"; plan?: never };

export type BrainCanvasEvent =
  | { kind: "brief"; detail: { session_id: string; updated_at: string } }
  | { kind: "activity"; detail: BrainActivity };

const PHASES: ReadonlySet<string> = new Set(["thinking", "planning", "saving", "pricing", "end"]);

/**
 * The runtime half of the contract, for the sender and for any listener (S3's canvas): a detail that breaks it is not an activity.
 * A null session on any phase but "thinking", an empty id, an unknown phase, or a plan with a null session are all refused.
 */
export function isBrainActivity(d: unknown): d is BrainActivity {
  if (!d || typeof d !== "object") return false;
  const a = d as Record<string, unknown>;
  if (typeof a.phase !== "string" || !PHASES.has(a.phase)) return false;
  if (a.session_id === null) return a.phase === "thinking" && a.plan === undefined;
  return typeof a.session_id === "string" && a.session_id.length > 0;
}

/** Dispatches one canvas event; an activity that breaks the contract is never sent (false), so a listener never sees one. */
export function dispatchBrainCanvas(e: BrainCanvasEvent): boolean {
  if (typeof window === "undefined") return false;
  if (e.kind === "activity" && !isBrainActivity(e.detail)) return false;
  if (e.kind === "brief" && !(typeof e.detail.session_id === "string" && e.detail.session_id.length > 0)) return false;
  window.dispatchEvent(new CustomEvent(e.kind === "brief" ? BRAIN_BRIEF_EVENT : BRAIN_ACTIVITY_EVENT, { detail: e.detail }));
  return true;
}
