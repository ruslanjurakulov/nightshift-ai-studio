/** Serializable editor-only layout, never provider instructions. */
import { z } from "zod";
import { WorkflowSchema, inspectWorkflow, type AgentWorkflow } from "./agent-graph";
import { clampPosition, type NodePosition } from "./agent-graph-editor";

const Position = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const Draft = z.object({
  format: z.literal("nightshift.agent-draft"),
  layoutVersion: z.literal(1),
  workflow: WorkflowSchema,
  positions: z.record(z.string(), Position),
}).strict();
export type WorkflowDraft = { format: "nightshift.agent-draft"; layoutVersion: 1; workflow: AgentWorkflow; positions: Record<string, NodePosition> };

export function defaultNodePosition(index: number): NodePosition {
  return { x: 20 + (index % 3) * 250, y: 20 + Math.floor(index / 3) * 250 };
}

export function exportWorkflowDraft(workflow: AgentWorkflow, positions: Record<string, NodePosition>): string {
  const report = inspectWorkflow(workflow);
  if (!report.ok) throw new Error("Invalid workflow");
  const retained: Record<string, NodePosition> = {};
  workflow.nodes.forEach((node, index) => {
    const at = positions[node.id] ?? defaultNodePosition(index);
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
  if (!inspectWorkflow(result.data.workflow).ok) throw new Error("Workflow validation failed");
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
    const a = positions[edge.source] ?? defaultNodePosition(from);
    const b = positions[edge.target] ?? defaultNodePosition(to);
    const x1 = a.x + 220, y1 = a.y + 72, x2 = b.x, y2 = b.y + 72;
    const bend = Math.max(50, Math.abs(x2 - x1) * 0.55);
    return [{ source: edge.source, target: edge.target, path: `M ${x1} ${y1} C ${x1+bend} ${y1}, ${x2-bend} ${y2}, ${x2} ${y2}` }];
  });
}
