/**
 * The Studio's Plan column (components/studio-live/PlanColumn.tsx): the plan a Nightshift AI conversation is building, drawn beside the
 * chat as it grows. The rules that decide what the person sees are here, as plain functions, so each can be pinned by a test.
 */
import type { LiveGraph, LiveNode } from "./liveGraph";

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

/** The plan's reading order: the idea and the script, then each scene's picture and its clip, then the rest (as LiveView's list). */
function readingOrder(a: LiveNode, b: LiveNode): number {
  const group = (n: LiveNode) => (n.col < 2 ? 0 : n.col <= 3 ? 1 : 2);
  return group(a) - group(b) || (group(a) === 1 ? a.row - b.row || a.col - b.col : a.col - b.col || a.row - b.row);
}

/**
 * The cards in `graph` that were not in the last reading, each with its place in the arrival order. `seen` null is a first reading
 * (the board just opened, or the page was refreshed): what is already there is not news, so nothing enters.
 */
export function enteringCards(seen: ReadonlySet<string> | null, graph: LiveGraph): Map<string, number> {
  if (!seen) return new Map();
  const fresh = graph.nodes.filter((n) => !seen.has(n.id)).sort(readingOrder);
  return new Map(fresh.map((n, i) => [n.id, Math.min(i, ENTER_CAP)]));
}

// ── where the board looks ───────────────────────────────────────────────────────────────────

export const PLAN_FIT = { pad: 24, minZoom: 0.72, maxZoom: 1 };
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The viewport that shows the plan at a readable zoom (LiveView's minimum, 0.72). A plan that fits is centred; one wider or taller than
 * the board starts at its first card, never in its middle. Null when there is nothing measured to place.
 */
export function planViewport(b: Rect, w: number, h: number, fit = PLAN_FIT): { x: number; y: number; zoom: number } | null {
  if (!(b.width > 0 && b.height > 0 && w > 0 && h > 0)) return null;
  const roomW = Math.max(1, w - 2 * fit.pad);
  const roomH = Math.max(1, h - 2 * fit.pad);
  const zoom = Math.min(fit.maxZoom, Math.max(fit.minZoom, Math.min(roomW / b.width, roomH / b.height)));
  const x = b.width * zoom <= roomW ? (w - b.width * zoom) / 2 - b.x * zoom : fit.pad - b.x * zoom;
  const y = b.height * zoom <= roomH ? (h - b.height * zoom) / 2 - b.y * zoom : fit.pad - b.y * zoom;
  return { x, y, zoom };
}
