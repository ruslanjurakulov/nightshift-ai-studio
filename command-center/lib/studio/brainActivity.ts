/**
 * What the Nightshift AI panel is doing right now, told to the rest of the page (docs/studio/S3_LIVE_MEASURE.md).
 *
 * The panel's only other signal, `nightshift:brain-brief`, fires after a turn has finished. The canvas column beside it could not tell
 * a turn had started, nor that a storyboard was being written, so it showed nothing for the 2-100 s a turn takes. This event says only
 * what the panel itself knows: a turn is out, a storyboard is being written, or nothing is in flight. It carries no progress, because
 * the server reports none (CLAUDE.md rule 5): a later phase that does report one must come from the server's own count.
 *
 * The one place the event is built and read, so the panel and the board can never disagree about its shape.
 */

export const BRAIN_ACTIVITY_EVENT = "nightshift:brain-activity";

/** Extend here (and only here): the parser accepts exactly these words, so a new phase is one line, and an unknown one is ignored. */
export const BRAIN_PHASES = ["thinking", "storyboard", "idle"] as const;
export type BrainPhase = (typeof BRAIN_PHASES)[number];

export interface BrainActivity {
  /** The conversation, or null while its first turn is out (the server has not answered with an id yet): a new conversation. */
  session_id: string | null;
  phase: BrainPhase;
}

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A detail from the event, or null when it is not one of ours: a malformed one is ignored, never read as "idle". */
export function parseBrainActivity(detail: unknown): BrainActivity | null {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const d = detail as Record<string, unknown>;
  if (typeof d.phase !== "string" || !(BRAIN_PHASES as readonly string[]).includes(d.phase)) return null;
  const sid = d.session_id;
  if (sid !== null && (typeof sid !== "string" || !SESSION.test(sid))) return null;
  return { session_id: sid, phase: d.phase as BrainPhase };
}

export function emitBrainActivity(detail: BrainActivity): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(BRAIN_ACTIVITY_EVENT, { detail }));
}

/** Calls `handler` with every well-formed activity; returns the unsubscribe. */
export function onBrainActivity(handler: (a: BrainActivity) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const on = (e: Event) => {
    const a = parseBrainActivity((e as CustomEvent<unknown>).detail);
    if (a) handler(a);
  };
  window.addEventListener(BRAIN_ACTIVITY_EVENT, on);
  return () => window.removeEventListener(BRAIN_ACTIVITY_EVENT, on);
}
