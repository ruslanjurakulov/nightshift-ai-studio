import type { BrainPhase } from "@/lib/brain/stream-events";

/**
 * The browser events the Nightshift AI panel sends the canvas beside it (docs/studio/LIVE_CREATION_PLAN.md §3.1, §3.8). One helper
 * dispatches both, so the panel, and S3's canvas when it adopts this, name them once.
 *
 *   nightshift:brain-brief    the conversation's BRIEF changed on the server: the canvas reads it again (useBrainBrief);
 *   nightshift:brain-activity what the server is doing for this conversation right now, from the stream's real events only:
 *                             { session_id, phase } (phase "end" once the answer arrived), with the plan's window counts while a
 *                             storyboard is written. Nothing here is a timer.
 *
 * Minimal on purpose: S3's own helper was not on main when this landed; the event names and detail shapes are the contract.
 */

export const BRAIN_BRIEF_EVENT = "nightshift:brain-brief";
export const BRAIN_ACTIVITY_EVENT = "nightshift:brain-activity";

export type BrainActivity = {
  session_id: string;
  phase: BrainPhase | "end";
  /** While a storyboard is written: windows arrived of all, and chapters complete of all. Absent otherwise. */
  plan?: { windows: number; of: number; chapters_written: number; chapters: number };
};

export type BrainCanvasEvent =
  | { kind: "brief"; detail: { session_id: string; updated_at: string } }
  | { kind: "activity"; detail: BrainActivity };

export function dispatchBrainCanvas(e: BrainCanvasEvent): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(e.kind === "brief" ? BRAIN_BRIEF_EVENT : BRAIN_ACTIVITY_EVENT, { detail: e.detail }));
}
