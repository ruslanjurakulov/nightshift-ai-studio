/** Serializable editor-only layout, never provider instructions. */
import { z } from "zod";
import { WorkflowSchema, inspectWorkflow, type AgentWorkflow } from "./agent-graph";
import { CONNECTIONS, clampPosition, type NodePosition } from "./agent-graph-editor";

const Position = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const Draft = z.object({
  format: z.literal("nightshift.agent-draft"),
  layoutVersion: z.literal(1),
  workflow: WorkflowSchema,
  positions: z.record(z.string(), Position),
}).strict();
export type WorkflowDraft = { format: "nightshift.agent-draft"; layoutVersion: 1; workflow: AgentWorkflow; positions: Record<string, NodePosition> };

/**
 * The read of an id-keyed map that only sees the map's own entries. A node id may be any name the id rule allows, and
 * "constructor", "toString" or "valueOf" are allowed (by agent-graph.ts and by migration 0130): on a plain object
 * `positions[id]` would then hand back Object.prototype's function, which draws the card at NaN and, through fitView, blanks
 * the whole canvas.
 */
export function ownEntry<T>(map: Readonly<Record<string, T>> | undefined, id: string): T | undefined {
  return map !== undefined && Object.hasOwn(map, id) ? map[id] : undefined;
}

/** The first 21 slots: three columns of 250px, seven rows, all inside clampPosition's 2200 x 1600. */
const GRID_SLOTS = 21;
/** Beyond them, a second block to the right of the first: 240px columns, the same 250px rows, 7 x 7 = 49 more slots. */
const OVERFLOW_X = 760;
const OVERFLOW_COLUMNS = 7;

/**
 * Where a node with no saved position is drawn. The first 21 slots are the ones every earlier draft was laid out in, so an
 * old draft without positions opens exactly as it did. Past them the old 3-column grid ran off the canvas and clampPosition
 * stacked every later card at y = 1600 (a 64-node import was 43 cards in one pile); those indices now fill the empty block
 * to the right instead, so all 64 nodes the schema allows get a slot of their own.
 */
export function defaultNodePosition(index: number): NodePosition {
  if (index < GRID_SLOTS) return { x: 20 + (index % 3) * 250, y: 20 + Math.floor(index / 3) * 250 };
  const k = index - GRID_SLOTS;
  return clampPosition(OVERFLOW_X + (k % OVERFLOW_COLUMNS) * 240, 20 + Math.floor(k / OVERFLOW_COLUMNS) * 250);
}

/**
 * The rules a stored draft must meet beyond the graph checks of inspectWorkflow: every edge is one of the typed CONNECTIONS. Migration
 * 0130's save_agent_workflow_draft() enforces the same list, so a draft this accepts is one the database accepts.
 */
function connectionsAllowed(workflow: AgentWorkflow): boolean {
  const types = new Map(workflow.nodes.map(node => [node.id, node.type]));
  return workflow.edges.every(edge => {
    const from = types.get(edge.source);
    const to = types.get(edge.target);
    return from !== undefined && to !== undefined && CONNECTIONS[from].includes(to);
  });
}

export function exportWorkflowDraft(workflow: AgentWorkflow, positions: Record<string, NodePosition>): string {
  const report = inspectWorkflow(workflow);
  if (!report.ok || !connectionsAllowed(workflow)) throw new Error("Invalid workflow");
  const retained: Record<string, NodePosition> = {};
  workflow.nodes.forEach((node, index) => {
    const at = ownEntry(positions, node.id) ?? defaultNodePosition(index);
    retained[node.id] = clampPosition(at.x, at.y);
  });
  return JSON.stringify({ format: "nightshift.agent-draft", layoutVersion: 1, workflow, positions: retained } satisfies WorkflowDraft, null, 2);
}

export function importWorkflowDraft(content: string): WorkflowDraft {
  if (content.length > 150_000) throw new Error("Draft exceeds 150 KB limit");
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { throw new Error("Invalid JSON file"); }
  const result = Draft.safeParse(parsed);
  if (!result.success) throw new Error("Unsupported or invalid Nightshift draft");
  if (!inspectWorkflow(result.data.workflow).ok || !connectionsAllowed(result.data.workflow)) throw new Error("Workflow validation failed");
  const ids = new Set(result.data.workflow.nodes.map(node => node.id));
  if (Object.keys(result.data.positions).some(id => !ids.has(id))) throw new Error("Layout contains unknown node");
  const positions: Record<string, NodePosition> = {};
  for (const [id, p] of Object.entries(result.data.positions)) {
    if (p.x < 0 || p.x > 2200 || p.y < 0 || p.y > 1600) throw new Error("Position outside canvas bounds");
    positions[id] = clampPosition(p.x, p.y);
  }
  return { ...result.data, positions };
}

export type CanvasEdge = { source: string; target: string; path: string };
/** Stable SVG cubic curves; coordinates are fixed world-space pixels. */
export function canvasEdges(workflow: AgentWorkflow, positions: Record<string, NodePosition>): CanvasEdge[] {
  const index = new Map(workflow.nodes.map((node, i) => [node.id, i]));
  return workflow.edges.flatMap(edge => {
    const from = index.get(edge.source);
    const to = index.get(edge.target);
    if (from === undefined || to === undefined) return [];
    const a = ownEntry(positions, edge.source) ?? defaultNodePosition(from);
    const b = ownEntry(positions, edge.target) ?? defaultNodePosition(to);
    const x1 = a.x + 220, y1 = a.y + 72, x2 = b.x, y2 = b.y + 72;
    const bend = Math.max(50, Math.abs(x2 - x1) * 0.55);
    return [{ source: edge.source, target: edge.target, path: `M ${x1} ${y1} C ${x1+bend} ${y1}, ${x2-bend} ${y2}, ${x2} ${y2}` }];
  });
}
