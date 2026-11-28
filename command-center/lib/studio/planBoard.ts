/**
 * The Studio's Plan column (components/studio-live/PlanColumn.tsx): the plan a Nightshift AI conversation is building, drawn beside the
 * chat as it grows. The rules that decide what the person sees are here, as plain functions, so each can be pinned by a test.
 */

// ── which view the canvas column shows ─────────────────────────────────────────────────────

export type ColumnView = "plan" | "canvas";
/** The person's own choice, and the conversation it was made in: it holds for that conversation only. */
export interface ViewMemory {
  session: string | null;
  view: ColumnView;
}

export const VIEW_MEMORY_KEY = "ns.studio.planColumn.v1";
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stored choice, or null when there is none that can be trusted (another version, a hand edit, storage refused). */
export function parseViewMemory(raw: string | null): ViewMemory | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.view !== "plan" && o.view !== "canvas") return null;
  if (o.session !== null && (typeof o.session !== "string" || !SESSION.test(o.session))) return null;
  return { session: o.session, view: o.view };
}

/**
 * A message was sent. Sending starts the plan, so the column shows it, even over a canvas with cards on it: unless the person, in this
 * same conversation, already chose their own canvas. A new conversation (no id yet, or another one) shows the plan again.
 */
export function viewOnSend(mem: ViewMemory | null, session: string | null): ColumnView {
  return mem && mem.view === "canvas" && session !== null && mem.session === session ? "canvas" : "plan";
}

/** A choice made while the first turn was out (no id yet) belongs to the conversation that turn turned out to start. */
export function adoptSession(mem: ViewMemory | null, session: string | null): ViewMemory | null {
  return mem && mem.session === null && session ? { ...mem, session } : mem;
}

/** On open: the person's own choice for this conversation; otherwise its plan when there is one, and their canvas when there is not. */
export function initialView(mem: ViewMemory | null, session: string | null): ColumnView {
  if (session && mem?.session === session) return mem.view;
  return session ? "plan" : "canvas";
}

// ── which cards are new ─────────────────────────────────────────────────────────────────────

/** More than this many new cards come in together: a 50-scene storyboard must not take seconds to finish arriving. */
export const ENTER_CAP = 16;

/**
 * The same rule for any list of card ids in reading order (the Plan column's storyboard: idea, script, cast, scenes, footer): the
 * ids not in the last reading, each with its place among them. `seen` null is a first reading: nothing enters.
 */
export function enteringIds(seen: ReadonlySet<string> | null, ids: readonly string[]): Map<string, number> {
  if (!seen) return new Map();
  const fresh = ids.filter((id) => !seen.has(id));
  return new Map(fresh.map((id, i) => [id, Math.min(i, ENTER_CAP)]));
}
