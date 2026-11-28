/**
 * The Agent Builder's bridge to React Flow (@xyflow/react, MIT). React Flow only draws and reports gestures: the workflow
 * (`AgentWorkflow`) and the layout (`positions`) stay the state, and every change React Flow reports is turned back into
 * a change of ours here, through lib/agent-graph-editor's rules. Pure functions, so the rules can be tested without a DOM.
 *
 * Nothing here trusts a handle id. A port is drawn per PORTS entry so a person can see where to drag, but whether a wire
 * is allowed is decided by the two nodes' types (checkConnection) and nothing else: a handle id is a DOM attribute anyone
 * can edit, and a rule keyed on it would be a rule until someone opens the devtools. (connectionAllowed narrows a pointer
 * drag further, so a wire is never drawn onto one port and then shown on another; it never widens what the types allow.)
 *
 * Every id-keyed read goes through ownEntry: a node id may be "constructor" or "toString", which a plain object answers
 * from its prototype.
 */
import type { Edge, Node, NodeChange, EdgeChange } from "@xyflow/react";
import type { AgentWorkflow, NodeType } from "./agent-graph";
import { PORTS, checkConnection, clampPosition, removeNode, type NodePosition, type PortKind } from "./agent-graph-editor";
import { defaultNodePosition, ownEntry } from "./agent-draft";

export type WorkflowNode = AgentWorkflow["nodes"][number];
export type AgentNodeData = { node: WorkflowNode; index: number };
export type AgentFlowNode = Node<AgentNodeData, "agent">;
export type AgentFlowEdge = Edge<Record<string, never>, "agent">;

/** One id per wire: a workflow holds at most one edge per (source, target), checkConnection refuses a second. */
export const edgeId = (source: string, target: string): string => `${source}->${target}`;

/** Where a node is drawn: its saved position, or the grid slot of its index when it has none (an old draft, a new node). */
export function nodePosition(positions: Record<string, NodePosition>, id: string, index: number): NodePosition {
  return ownEntry(positions, id) ?? defaultNodePosition(index);
}

export function toFlowNodes(
  graph: AgentWorkflow,
  positions: Record<string, NodePosition>,
  view: { dragging?: Record<string, NodePosition>; selected?: ReadonlySet<string>; measured?: Record<string, { width: number; height: number }> } = {},
): AgentFlowNode[] {
  return graph.nodes.map((node, index) => ({
    id: node.id,
    type: "agent",
    position: ownEntry(view.dragging, node.id) ?? nodePosition(positions, node.id, index),
    selected: view.selected?.has(node.id) ?? false,
    // A controlled flow must hand React Flow's own measurement back, or it keeps the node hidden.
    measured: ownEntry(view.measured, node.id),
    data: { node, index },
  }));
}

/**
 * The port a wire is drawn between. Derived from the two types, so the line lands on the port it means (the single output,
 * and the input that output feeds); it is drawing only, and a type pair with no shared port gets none.
 */
export function wirePorts(source: NodeType, target: NodeType): { sourceHandle: PortKind | null; targetHandle: PortKind | null } {
  const out = PORTS[source].output.find(port => PORTS[target].input.includes(port)) ?? null;
  return { sourceHandle: out, targetHandle: out };
}

/**
 * What a pointer drag may drop on: the pair checkConnection allows and, when React Flow names the handles, exactly the ports
 * wirePorts would draw the wire between. Without the second part a wire dropped on review's "video" input would be drawn on
 * its "image" input the moment it was added. Handles only narrow; the types remain the rule.
 */
export function connectionAllowed(
  graph: AgentWorkflow,
  conn: { source: string | null; target: string | null; sourceHandle?: string | null; targetHandle?: string | null },
): boolean {
  if (!checkConnection(graph, conn.source ?? "", conn.target ?? "").ok) return false;
  const from = graph.nodes.find(n => n.id === conn.source)!.type;
  const to = graph.nodes.find(n => n.id === conn.target)!.type;
  const ports = wirePorts(from, to);
  if (conn.sourceHandle && conn.sourceHandle !== ports.sourceHandle) return false;
  if (conn.targetHandle && conn.targetHandle !== ports.targetHandle) return false;
  return true;
}

/** The refusals checkConnection (and inspectWorkflow behind it) can give, as keys a dictionary can translate. */
export type ConnectionReason = "pick" | "types" | "exists" | "cycle" | "review" | "selfEdge" | "tooMany" | "invalid";
export function connectionReason(reason: string): ConnectionReason | null {
  if (reason === "Choose two existing nodes.") return "pick";
  if (reason === "These node types cannot be connected.") return "types";
  if (reason === "Connection already exists." || reason === "Duplicate edge") return "exists";
  if (reason === "Workflow contains a cycle") return "cycle";
  if (reason.startsWith("Export requires an upstream review.approval")) return "review";
  if (reason === "Self-edge is forbidden") return "selfEdge";
  if (reason.startsWith("edges:")) return "tooMany";
  if (reason === "Invalid graph.") return "invalid";
  return null;
}

/**
 * The card to focus after `removed` leave: the next card that stays, else the previous one, else none (the canvas then).
 * Without it, focus falls to <body> with the Remove button that held it, and a keyboard user starts again from the top.
 */
export function focusAfterRemoval(graph: AgentWorkflow, removed: ReadonlySet<string>): string | null {
  const ids = graph.nodes.map(n => n.id);
  const first = ids.findIndex(id => removed.has(id));
  if (first < 0) return null;
  const after = ids.slice(first).find(id => !removed.has(id));
  if (after) return after;
  return [...ids.slice(0, first)].reverse().find(id => !removed.has(id)) ?? null;
}

export function toFlowEdges(graph: AgentWorkflow, selected: ReadonlySet<string> = new Set()): AgentFlowEdge[] {
  const types = new Map(graph.nodes.map(node => [node.id, node.type]));
  return graph.edges.flatMap(edge => {
    const from = types.get(edge.source);
    const to = types.get(edge.target);
    if (!from || !to) return [];
    const id = edgeId(edge.source, edge.target);
    return [{
      id,
      source: edge.source,
      target: edge.target,
      ...wirePorts(from, to),
      type: "agent" as const,
      selected: selected.has(id),
      // The wide invisible path a finger can actually hit on a phone.
      interactionWidth: 22,
    }];
  });
}

/**
 * A wire dropped on a port. Checked again here, not only in isValidConnection: that one only colours the drag, and a
 * drop can arrive without it (a stale render, a synthetic event). A refusal returns the very same graph object.
 */
export function applyConnect(graph: AgentWorkflow, source: string | null | undefined, target: string | null | undefined):
  { graph: AgentWorkflow; ok: boolean; reason: string } {
  const outcome = checkConnection(graph, source ?? "", target ?? "");
  if (!outcome.ok || !source || !target) return { graph, ok: false, reason: outcome.reason };
  return { graph: { ...graph, edges: [...graph.edges, { source, target }] }, ok: true, reason: outcome.reason };
}

/** Disconnect by wire id. Ids of wires we do not hold change nothing. */
export function removeEdges(graph: AgentWorkflow, ids: ReadonlySet<string>): AgentWorkflow {
  if (!graph.edges.some(e => ids.has(edgeId(e.source, e.target)))) return graph;
  return { ...graph, edges: graph.edges.filter(e => !ids.has(edgeId(e.source, e.target))) };
}

/** A node removed: its wires go with it (removeNode), and so does its saved position, so a later node of that id starts fresh. */
export function removeNodeAndPosition(graph: AgentWorkflow, positions: Record<string, NodePosition>, id: string):
  { graph: AgentWorkflow; positions: Record<string, NodePosition> } {
  if (!graph.nodes.some(n => n.id === id)) return { graph, positions };
  return { graph: removeNode(graph, id), positions: dropPosition(positions, id) };
}

/** The map without `id` (a position, a drag in progress, a measured size); the same object when it had no such entry. */
export function dropPosition<T>(positions: Record<string, T>, id: string): Record<string, T> {
  if (!Object.hasOwn(positions, id)) return positions;
  const rest = { ...positions };
  delete rest[id];
  return rest;
}

export type NodeChangeOutcome = {
  /** Positions to keep for good: a finished drag or a keyboard move, clamped to the canvas. */
  persist: Record<string, NodePosition>;
  /** Positions mid-drag, clamped too, drawn but not yet saved. */
  dragging: Record<string, NodePosition>;
  /** Ids of our nodes React Flow asked to delete (Delete / Backspace on a selected node). */
  remove: string[];
  select: Record<string, boolean>;
  measured: Record<string, { width: number; height: number }>;
};

/** React Flow's node changes, sorted into ours. Anything about an id not in the workflow is dropped. */
export function readNodeChanges(graph: AgentWorkflow, changes: NodeChange<AgentFlowNode>[]): NodeChangeOutcome {
  const ids = new Set(graph.nodes.map(n => n.id));
  const out: NodeChangeOutcome = { persist: {}, dragging: {}, remove: [], select: {}, measured: {} };
  for (const ch of changes) {
    if (!("id" in ch) || !ids.has(ch.id)) continue;
    if (ch.type === "position" && ch.position) {
      const at = clampPosition(ch.position.x, ch.position.y);
      if (ch.dragging) out.dragging[ch.id] = at;
      else out.persist[ch.id] = at;
    } else if (ch.type === "remove") out.remove.push(ch.id);
    else if (ch.type === "select") out.select[ch.id] = ch.selected;
    else if (ch.type === "dimensions" && ch.dimensions) out.measured[ch.id] = ch.dimensions;
  }
  return out;
}

/** React Flow's edge changes, sorted into ours: deletions and selection of wires we hold. */
export function readEdgeChanges(graph: AgentWorkflow, changes: EdgeChange<AgentFlowEdge>[]): { remove: Set<string>; select: Record<string, boolean> } {
  const ids = new Set(graph.edges.map(e => edgeId(e.source, e.target)));
  const remove = new Set<string>();
  const select: Record<string, boolean> = {};
  for (const ch of changes) {
    if (!("id" in ch) || !ids.has(ch.id)) continue;
    if (ch.type === "remove") remove.add(ch.id);
    else if (ch.type === "select") select[ch.id] = ch.selected;
  }
  return { remove, select };
}
