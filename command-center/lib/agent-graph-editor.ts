import type { AgentWorkflow, NodeType } from "./agent-graph";
import { inspectWorkflow } from "./agent-graph";

/** Typed, allowlisted connections for the first visual planner. */
export const CONNECTIONS: Readonly<Record<NodeType, readonly NodeType[]>> = {
  "brand.input": ["prompt.compose"],
  "product.catalog": ["prompt.compose"],
  "prompt.compose": ["image.generate", "vector.generate", "video.generate"],
  "image.generate": ["review.approval"],
  "vector.generate": ["review.approval"],
  "video.generate": ["review.approval"],
  "review.approval": ["asset.export"],
  "asset.export": [],
};

export function checkConnection(workflow: AgentWorkflow, source: string, target: string): { ok: boolean; reason: string } {
  const src = workflow.nodes.find(n => n.id === source);
  const dst = workflow.nodes.find(n => n.id === target);
  if (!src || !dst) return { ok: false, reason: "Choose two existing nodes." };
  if (!CONNECTIONS[src.type].includes(dst.type)) return { ok: false, reason: "These node types cannot be connected." };
  if (workflow.edges.some(e => e.source === source && e.target === target)) return { ok: false, reason: "Connection already exists." };
  const candidate = { ...workflow, edges: [...workflow.edges, { source, target }] };
  const status = inspectWorkflow(candidate);
  if (!status.ok) return { ok: false, reason: status.errors[0] || "Invalid graph." };
  return { ok: true, reason: "Connection permitted." };
}

export function addNode(workflow: AgentWorkflow, type: NodeType): AgentWorkflow {
  if (workflow.nodes.length >= 64) return workflow;
  const used = new Set(workflow.nodes.map(n => n.id));
  const prefix = type.replace(/\W+/g, "_");
  let next = 1;
  while (used.has(`${prefix}_${next}`)) next++;
  return {
    ...workflow,
    nodes: [...workflow.nodes, { id: `${prefix}_${next}`, type, label: type.replace(".", " / "), config: {} }],
  };
}

export function removeNode(workflow: AgentWorkflow, id: string): AgentWorkflow {
  return {
    ...workflow,
    nodes: workflow.nodes.filter(n => n.id !== id),
    edges: workflow.edges.filter(e => e.source !== id && e.target !== id),
  };
}
