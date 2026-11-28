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

export const BOARD_STAGES = ["proposing", "planning", "ready", "making", "assembled"] as const;
export type BoardStage = (typeof BOARD_STAGES)[number];

export type BoardInput =
  /** The conversation's brief; `writing`: the panel is writing its storyboard right now. */
  | { source: "brief"; brief: Brief; writing?: boolean }
  /** A live reading of what Create made (filmGraph or runGraph). */
  | { source: "live"; graph: LiveGraph };

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

export function reduceBoard(prev: BoardModel | null, input: BoardInput): BoardModel {
  const raw = input.source === "brief" ? briefGraph(input.brief) : keepRefs(prev?.graph ?? null, input.graph);
  const graph = reuseGraph(prev?.graph ?? null, raw);
  const stage = stageOf(input, graph);
  if (prev && prev.graph === graph && prev.stage === stage) return prev;
  return { stage, graph };
}

/** Steps a film reading marks done the moment it exists (filmGraph: the idea and the script are the plan itself). */
const DONE_AT_ONCE = new Set(["idea", "script", "character", "location", "prop"]);

/**
 * A live reading with a step lit: one working, or one finished beyond what a film has the moment it is created. The `ns:live:first-lit`
 * mark's condition; a board of only "waiting" steps and a done idea is not lit.
 */
export function hasLitStep(g: LiveGraph): boolean {
  return g.nodes.some((n) => n.status === "working" || (n.status === "done" && !DONE_AT_ONCE.has(n.kind)));
}
