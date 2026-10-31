/**
 * Nightshift Agent/Node Builder foundation.
 * Declarative plans only: this module NEVER executes provider calls.
 */
import { z } from "zod";

export const NODE_TYPES = [
  "brand.input",
  "product.catalog",
  "prompt.compose",
  "image.generate",
  "vector.generate",
  "video.generate",
  "review.approval",
  "asset.export",
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

const NodeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  type: z.enum(NODE_TYPES),
  label: z.string().trim().min(1).max(80),
  config: z.record(z.string(), z.union([z.string().max(500), z.number().finite(), z.boolean()])).default({}),
}).strict();

const EdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
}).strict();

export const WorkflowSchema = z.object({
  version: z.literal(1),
  name: z.string().trim().min(1).max(120),
  nodes: z.array(NodeSchema).max(64),
  edges: z.array(EdgeSchema).max(128),
}).strict();

export type AgentWorkflow = z.infer<typeof WorkflowSchema>;

const REQUIRES_APPROVAL = new Set<NodeType>(["asset.export"]);
const CREATIVE_TYPES = new Set<NodeType>(["image.generate", "video.generate", "vector.generate"]);

// Only registry-defined types are valid; no arbitrary code nodes, URLs,
// shell commands, JS snippets or user-supplied provider identifiers.
export function inspectWorkflow(input: unknown): { ok: boolean; errors: string[]; order: string[]; requiresApproval: boolean } {
  const parsed = WorkflowSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map(i => i.path.join(".") + ": " + i.message), order: [], requiresApproval: false };
  const { nodes, edges } = parsed.data;
  const errors: string[] = [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  if (byId.size !== nodes.length) errors.push("Duplicate node IDs");
  const graph = new Map(nodes.map(n => [n.id, [] as string[]]));
  const indegree = new Map(nodes.map(n => [n.id, 0]));
  const seenEdges = new Set<string>();
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) {
      errors.push("Edge references unknown node");
      continue;
    }
    if (edge.source === edge.target) errors.push("Self-edge is forbidden");
    const key = edge.source + "->" + edge.target;
    if (seenEdges.has(key)) errors.push("Duplicate edge");
    seenEdges.add(key);
    graph.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, indegree.get(edge.target)! + 1);
  }
  const queue = nodes.filter(n => indegree.get(n.id) === 0).map(n => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of graph.get(id)!) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) errors.push("Workflow contains a cycle");
  // No export without a review checkpoint on EACH path to export, not merely
  // somewhere in the graph.
  const predecessors = new Map(nodes.map(n => [n.id, [] as string[]]));
  edges.forEach(e => { if (predecessors.has(e.target) && byId.has(e.source)) predecessors.get(e.target)!.push(e.source); });
  const reviewed = new Map<string, boolean>();
  for (const id of order) {
    const n = byId.get(id)!;
    const prev = predecessors.get(id)!;
    const everyPathReviewed = prev.length > 0 && prev.every(p => reviewed.get(p) === true);
    const approved = n.type === "review.approval" || everyPathReviewed;
    reviewed.set(id, approved);
    if (REQUIRES_APPROVAL.has(n.type) && !everyPathReviewed) {
      errors.push("Export requires an upstream review.approval node on every path");
    }
    if (CREATIVE_TYPES.has(n.type) && (n.config.providerKey || n.config.apiKey || n.config.endpoint)) {
      errors.push("Provider credentials/endpoints are forbidden in graph config");
    }
  }
  return { ok: errors.length === 0, errors, order: errors.length ? [] : order, requiresApproval: nodes.some(n => REQUIRES_APPROVAL.has(n.type)) };
}

export function createCampaignWorkflow(): AgentWorkflow {
  return {
    version: 1,
    name: "Brand to reviewed ad asset",
    nodes: [
      { id: "brand", type: "brand.input", label: "Brand kit", config: {} },
      { id: "products", type: "product.catalog", label: "Approved products", config: {} },
      { id: "prompt", type: "prompt.compose", label: "Campaign concept", config: {} },
      { id: "image", type: "image.generate", label: "Image task placeholder", config: {} },
      { id: "review", type: "review.approval", label: "Human review required", config: {} },
      { id: "export", type: "asset.export", label: "Export after approval", config: {} },
    ],
    edges: [
      { source: "brand", target: "prompt" },
      { source: "products", target: "prompt" },
      { source: "prompt", target: "image" },
      { source: "image", target: "review" },
      { source: "review", target: "export" },
    ],
  };
}
