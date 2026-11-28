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
  | { session_id: null; phase: "thinking"; reason?: never; plan?: never }
  /** A first send that made no session ended without an answer (Atlas, 28 Nov): only after a null "thinking", never with a plan. */
  | { session_id: null; phase: "end"; reason: "failed"; plan?: never };

/**
 * S3's addition to the contract (LIVE_CREATION_PLAN item 9, "Create in place"), for #989 to mirror: the person's confirmed Create went
 * through (S2's start route answered ok) and this conversation became this film. Sent once per start, before the panel records the
 * handoff on the server, so the board beside it reads the film at once instead of after a page reload. It carries ids only (no
 * quote, no money): the board reads everything else from the read-only live route. The server's handoff stays the truth after a
 * refresh; this event and `&film=` in the URL are how the page on screen learns it first.
 */
export const BRAIN_HANDOFF_EVENT = "nightshift:brain-handoff";
export type BrainHandoff = { session_id: string; film_id: string };

export type BrainCanvasEvent =
  | { kind: "brief"; detail: { session_id: string; updated_at: string } }
  | { kind: "activity"; detail: BrainActivity }
  | { kind: "handoff"; detail: BrainHandoff };

const FILM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The handoff's runtime guard: a real session and a film id that is a UUID (films.id), nothing else read. */
export function isBrainHandoff(d: unknown): d is BrainHandoff {
  if (!d || typeof d !== "object" || Array.isArray(d)) return false;
  const h = d as Record<string, unknown>;
  return typeof h.session_id === "string" && h.session_id.length > 0 && typeof h.film_id === "string" && FILM_UUID.test(h.film_id);
}

const PHASES: ReadonlySet<string> = new Set(["thinking", "planning", "saving", "pricing", "end"]);

/**
 * The runtime half of the contract, for the sender and for any listener (S3's canvas): a detail that breaks it is not an activity.
 * A null session is allowed only on "thinking" (a first send) and on "end" with reason "failed" (that send made no session); an
 * empty id, an unknown phase, or a plan with a null session are all refused.
 */
export function isBrainActivity(d: unknown): d is BrainActivity {
  if (!d || typeof d !== "object") return false;
  const a = d as Record<string, unknown>;
  if (typeof a.phase !== "string" || !PHASES.has(a.phase)) return false;
  if (a.session_id === null) {
    if (a.plan !== undefined) return false;
    return (a.phase === "thinking" && a.reason === undefined) || (a.phase === "end" && a.reason === "failed");
  }
  return typeof a.session_id === "string" && a.session_id.length > 0;
}

/** Dispatches one canvas event; an activity that breaks the contract is never sent (false), so a listener never sees one. */
export function dispatchBrainCanvas(e: BrainCanvasEvent): boolean {
  if (typeof window === "undefined") return false;
  if (e.kind === "activity" && !isBrainActivity(e.detail)) return false;
  if (e.kind === "brief" && !(typeof e.detail.session_id === "string" && e.detail.session_id.length > 0)) return false;
  if (e.kind === "handoff" && !isBrainHandoff(e.detail)) return false;
  // S3-local, the one line not in #989: remembered for a listener that mounts late (the replay below).
  if (e.kind === "activity") lastByWindow.set(window, e.detail);
  const name = e.kind === "brief" ? BRAIN_BRIEF_EVENT : e.kind === "handoff" ? BRAIN_HANDOFF_EVENT : BRAIN_ACTIVITY_EVENT;
  window.dispatchEvent(new CustomEvent(name, { detail: e.detail }));
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
  if (mapped.session_id === null) return mapped.phase === "end" ? { session_id: null, phase: "end", reason: "failed" } : { session_id: null, phase: "thinking" };
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

/**
 * Calls `handler` with every well-formed handoff (a conversation id the board can read, a film UUID); returns the unsubscribe. No
 * replay: a board that mounts after the event is a page that was loaded, and a loaded page has `&film=` in its URL or the handoff
 * in the conversation's brief.
 */
export function onBrainHandoff(handler: (h: BrainHandoff) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const on = (e: Event) => {
    const d = (e as CustomEvent<unknown>).detail;
    if (isBrainHandoff(d) && SESSION.test(d.session_id)) handler({ session_id: d.session_id, film_id: d.film_id.toLowerCase() });
  };
  window.addEventListener(BRAIN_HANDOFF_EVENT, on);
  return () => window.removeEventListener(BRAIN_HANDOFF_EVENT, on);
}
