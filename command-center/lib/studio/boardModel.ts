/**
 * The one board a plan is drawn on, from the first proposal to the finished film (docs/studio/LIVE_CREATION_PLAN.md §3.8): a pure
 * reducer from what was last read to what the board shows. StoryBoard renders it, in LiveView and in the Studio's Plan column.
 *
 * Stages, and where each comes from:
 *   proposing  the conversation's brief, no storyboard yet (outlines are being proposed or chosen between)
 *   planning   the panel says a storyboard is being written (its `nightshift:brain-activity` "storyboard" phase)
 *   ready      the brief has its storyboard (scenes), or says it was created and the film is not read yet
 *   making     the film or channel run, read live (filmGraph / runGraph), not finished
 *   assembled  the film's final video exists (its `final` step done), or the channel run's upload is done
 *
 * Two promises the board keeps across readings, both pinned by tests/studio-board-model.test.ts:
 *   - a card that did not change is the same object, so React (and React Flow) re-render nothing for it;
 *   - the character, place and prop cards the brief drew stay after Create, with the brief's data, until the film carries its own.
 */
import { briefGraph, type Brief, type LiveEdge, type LiveGraph, type LiveNode } from "./liveGraph";
import { DONE_AT_ONCE } from "./planGrid";

export const BOARD_STAGES = ["proposing", "planning", "ready", "making", "assembled"] as const;
export type BoardStage = (typeof BOARD_STAGES)[number];

export type BoardInput =
  /** The conversation's brief; `writing`: the panel is writing its storyboard right now. */
  | { source: "brief"; brief: Brief; writing?: boolean }
  /**
   * A live reading of what Create made (filmGraph or runGraph). `brief`: the conversation's plan, when it is read: its cast cards
   * and each scene's cast and planned length are carried onto the film's cards (Lens M2, M3: taken from the brief itself, so a
   * refresh whose film reading lands first still gets them when the brief arrives).
   */
  | { source: "live"; graph: LiveGraph; brief?: Brief | null };

export interface BoardModel {
  stage: BoardStage;
  graph: LiveGraph;
}

const REF_KINDS = new Set(["character", "location", "prop"]);

export function stageOf(input: BoardInput, graph: LiveGraph): BoardStage {
  if (input.source === "brief") {
    if (input.writing) return "planning";
    return input.brief.scenes.length > 0 || input.brief.status === "ready" || input.brief.status === "created" ? "ready" : "proposing";
  }
  return graph.nodes.some((n) => (n.kind === "final" || n.kind === "upload") && n.status === "done") ? "assembled" : "making";
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Field by field: a node is small and flat (credits is the one nested record). */
function sameNode(a: LiveNode, b: LiveNode): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof LiveNode>;
  for (const k of keys) if (!same(a[k], b[k])) return false;
  return true;
}

/** What a reading says besides its steps (settled, the run's facts, the activity log). */
const rest = (g: LiveGraph) => Object.fromEntries(Object.entries(g).filter(([k]) => k !== "nodes" && k !== "edges"));

const edgeKey = (e: LiveEdge) => `${e.from}->${e.to}`;

/**
 * After Create, the film reading has no character, place or prop steps yet (filmGraph draws none): the brief's stay, as the brief had
 * them, with only the wires whose both ends are still on the board.
 */
function keepRefs(prev: LiveGraph | null, next: LiveGraph): LiveGraph {
  if (!prev || next.nodes.some((n) => REF_KINDS.has(n.kind))) return next;
  const refs = prev.nodes.filter((n) => REF_KINDS.has(n.kind));
  if (!refs.length) return next;
  const ids = new Set([...next.nodes, ...refs].map((n) => n.id));
  const refIds = new Set(refs.map((n) => n.id));
  const have = new Set(next.edges.map(edgeKey));
  const wires = prev.edges.filter((e) => (refIds.has(e.from) || refIds.has(e.to)) && ids.has(e.from) && ids.has(e.to) && !have.has(edgeKey(e)));
  return { ...next, nodes: [...next.nodes, ...refs], edges: [...next.edges, ...wires] };
}

/** `next` with every node (and the edge list) that did not change replaced by the previous object; `prev` itself when nothing did. */
export function reuseGraph(prev: LiveGraph | null, next: LiveGraph): LiveGraph {
  if (!prev) return next;
  const before = new Map(prev.nodes.map((n) => [n.id, n]));
  let changed = prev.nodes.length !== next.nodes.length;
  const nodes = next.nodes.map((n, i) => {
    const old = before.get(n.id);
    if (old && sameNode(old, n)) {
      if (prev.nodes[i] !== old) changed = true;
      return old;
    }
    changed = true;
    return n;
  });
  const edgesSame = prev.edges.length === next.edges.length && prev.edges.every((e, i) => edgeKey(e) === edgeKey(next.edges[i]));
  const edges = edgesSame ? prev.edges : next.edges;
  if (!changed && edgesSame && same(rest(prev), rest(next))) return prev;
  return { ...next, nodes, edges };
}

/** What the film's reading does not say about a scene card that the plan did: its cast and its planned length. */
function carryPlan(plan: LiveGraph | null, next: LiveGraph): LiveGraph {
  if (!plan) return next;
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  let changed = false;
  const nodes = next.nodes.map((n) => {
    const p = byId.get(n.id);
    if (!p) return n;
    const cast = (!n.cast || n.cast.length === 0) && p.cast?.length ? p.cast : n.cast;
    const seconds = (typeof n.seconds !== "number" || n.seconds <= 0) && typeof p.seconds === "number" && p.seconds > 0 ? p.seconds : n.seconds;
    if (cast === n.cast && seconds === n.seconds) return n;
    changed = true;
    return { ...n, cast, seconds };
  });
  return changed ? { ...next, nodes } : next;
}

export function reduceBoard(prev: BoardModel | null, input: BoardInput): BoardModel {
  const plan = input.source === "live" ? (input.brief ? briefGraph(input.brief) : (prev?.graph ?? null)) : null;
  const raw = input.source === "brief" ? briefGraph(input.brief) : carryPlan(plan, keepRefs(plan, input.graph));
  const graph = reuseGraph(prev?.graph ?? null, raw);
  const stage = stageOf(input, graph);
  if (prev && prev.graph === graph && prev.stage === stage) return prev;
  return { stage, graph };
}

/**
 * A live reading with a step lit: one working, or one that turned done since the film's first reading. The `ns:live:first-lit` mark's
 * condition. Done at the first reading is not lit (Lens nit): the idea and script, and a key frame taken from an existing file, are
 * done the moment the film exists. `doneAtFirst`: the ids done in the first reading; without it, only DONE_AT_ONCE kinds are excluded.
 */
export function hasLitStep(g: LiveGraph, doneAtFirst?: ReadonlySet<string>): boolean {
  return g.nodes.some((n) => n.status === "working" || (n.status === "done" && !DONE_AT_ONCE.has(n.kind) && !doneAtFirst?.has(n.id)));
}
