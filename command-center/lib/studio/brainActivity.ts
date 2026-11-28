/**
 * Copy of lib/brain/canvas-events.ts (#989); delete when it lands. Names, shapes and the dispatch function are S1's, verbatim, so the
 * panel's calls are a drop-in either way; what is added here is local to S3's board: a tolerant parser and the replay for a listener
 * that mounts late. `session_id` is `string | null` (Atlas): null ONLY on a first send's "thinking", before the server has answered
 * with an id; on any other phase a null is refused (isBrainActivity) and never sent.
 *
 * The browser events the Nightshift AI panel sends the canvas beside it (docs/studio/LIVE_CREATION_PLAN.md §3.1, §3.8):
 *   nightshift:brain-brief    the conversation's BRIEF changed on the server: the canvas reads it again (useBrainBrief);
 *   nightshift:brain-activity what the panel or the server is doing for this conversation right now: { session_id, phase } (phase
 *                             "end" once the answer arrived), with the plan's real window and chapter counts while a storyboard is
 *                             written and the server reports them. Nothing here is a timer, and no count is ever made up here
 *                             (CLAUDE.md rule 5): without `plan`, the board says only that the storyboard is being written.
 *
 * Measured on main (docs/studio/S3_LIVE_MEASURE.md): before these events the column beside the panel could not tell that a turn had
 * started, nor that a storyboard was being written, and showed nothing for the 2–100 s a turn takes.
 */

// ── Copy of lib/brain/canvas-events.ts (#989 @ 13dab36c8), verbatim but for BrainPhase, which is #989's lib/brain/stream-events.ts
// (not on main). Delete this block, and import from "@/lib/brain/canvas-events", when #989 lands. ──────────────────────────────

/** #989's lib/brain/stream-events.ts: real phases of a turn or a choice, in the order they can happen. */
export const BRAIN_PHASES = ["thinking", "planning", "saving", "pricing"] as const;
export type BrainPhase = (typeof BRAIN_PHASES)[number];

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
  // S3-local, the one line not in #989: remembered for a listener that mounts late (the replay below).
  if (e.kind === "activity") lastByWindow.set(window, e.detail);
  window.dispatchEvent(new CustomEvent(e.kind === "brief" ? BRAIN_BRIEF_EVENT : BRAIN_ACTIVITY_EVENT, { detail: e.detail }));
  return true;
}

// ── S3's listener (stays when #989 lands) ──────────────────────────────────────────────────────────────────────────────────

/** What the board hears: an activity, marked when it is a replay to a late listener (what is in flight, never a new act: Lens H2). */
export type HeardActivity = BrainActivity & { replayed?: boolean };

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The words of this PR's first version, still understood here (never sent) while S1's panel and this one meet in merges. */
const OLD: Record<string, BrainActivity["phase"]> = { storyboard: "planning", idle: "end" };
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Counts that contradict themselves are no counts: the board then says only "writing", never a wrong number (rule 5). */
function sanePlan(v: unknown): BrainActivityPlan | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const p = v as Record<string, unknown>;
  if (!count(p.windows) || !count(p.of) || !count(p.chapters_written) || !count(p.chapters)) return undefined;
  if (p.windows > p.of || p.chapters_written > p.chapters || p.chapters === 0) return undefined;
  return { windows: p.windows, of: p.of, chapters_written: p.chapters_written, chapters: p.chapters };
}

/**
 * A detail as the board reads it, or null when it is not one: the legacy words mapped, then #989's own guard (isBrainActivity), then
 * the counts checked and kept on "planning" only. A malformed detail is ignored, never read as "end".
 */
export function parseBrainActivity(detail: unknown): BrainActivity | null {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const d = detail as Record<string, unknown>;
  const mapped = typeof d.phase === "string" && Object.hasOwn(OLD, d.phase) ? { ...d, phase: OLD[d.phase] } : d;
  if (!isBrainActivity(mapped)) return null;
  if (mapped.session_id === null) return { session_id: null, phase: "thinking" };
  // The board reads the conversation by its id from the URL: one that is not a conversation id is not one it can read.
  if (!SESSION.test(mapped.session_id)) return null;
  const plan = mapped.phase === "planning" ? sanePlan(mapped.plan) : undefined;
  return plan ? { session_id: mapped.session_id, phase: mapped.phase, plan } : { session_id: mapped.session_id, phase: mapped.phase };
}

/**
 * The last activity this page sent, per window, so a listener that mounts late (a refresh mid-storyboard: the panel re-emits from
 * its own mount, before the board beside it subscribes) still learns what is in flight. Only "planning" is replayed: it runs for
 * minutes, while a "thinking" left behind would make a fresh column adopt another conversation (Lens H2).
 */
const lastByWindow = new WeakMap<object, BrainActivity>();

/** Calls `handler` with a replay of an in-flight storyboard (if any), then with every new well-formed activity; returns the unsubscribe. */
export function onBrainActivity(handler: (a: HeardActivity) => void, { replay = true }: { replay?: boolean } = {}): () => void {
  if (typeof window === "undefined") return () => {};
  const w = window;
  const on = (e: Event) => {
    const a = parseBrainActivity((e as CustomEvent<unknown>).detail);
    if (a) handler(a);
  };
  w.addEventListener(BRAIN_ACTIVITY_EVENT, on);
  const last = lastByWindow.get(w);
  const again = last ? parseBrainActivity(last) : null;
  if (replay && again && again.phase === "planning") handler({ ...again, replayed: true });
  return () => w.removeEventListener(BRAIN_ACTIVITY_EVENT, on);
}

/** Forget the last activity (the panel unmounts, or starts a new chat): nothing is left behind for a later listener. */
export function clearBrainActivity(): void {
  if (typeof window === "undefined") return;
  lastByWindow.delete(window);
}
