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

/**
 * Characters a name or a label may never hold: the class of BR-L-120 (modules/comment_replies.py `_STRIP`, migration 0081
 * `inbox_clean_text`) plus the line feed. Controls (C0, C1, DEL, so no ANSI escapes), soft hyphen, grapheme joiner, Arabic letter mark,
 * Hangul/Khmer fillers, Mongolian selectors, zero-width and direction marks, embeddings, overrides and isolates, invisible operators,
 * braille blank, variation selectors FE00-FE0D, BOM, interlinear annotation controls, Egyptian/Bamum/musical format controls and the
 * Unicode tag block. Migration 0130 (`v_refused` in save_agent_workflow_draft) refuses exactly the same class.
 */
export const REFUSED_TEXT_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0d\ufeff\uffa0\ufff0-\ufffb\u{13430}-\u{1343f}\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/u;
/** At least one character that is not a space (ASCII or a blank-looking one): the same rule as 0130's `v_visible`. */
const VISIBLE_CHAR = /[^ \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u;

/**
 * A plan's name or a node's label, checked RAW (before trimming) exactly as migration 0130 checks it: 1 to `max` characters counted
 * as code points (Postgres char_length), a visible character, none of REFUSED_TEXT_CHARS. Trimmed afterwards, so what is stored is
 * never longer than what was checked.
 */
function displayText(max: number) {
  return z.string()
    .refine(s => { const n = Array.from(s).length; return n >= 1 && n <= max; }, { message: `1 to ${max} characters` })
    .refine(s => !REFUSED_TEXT_CHARS.test(s), { message: "Control, direction or invisible characters are not allowed" })
    .refine(s => VISIBLE_CHAR.test(s), { message: "Needs a visible character" })
    .transform(s => s.trim());
}

const NodeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  type: z.enum(NODE_TYPES),
  label: displayText(80),
  // Empty until a reviewed per-node config schema exists: the database (0130) refuses anything but {} too, so no provider key,
  // endpoint or setting can be stored in a plan.
  config: z.object({}).strict().default({}),
}).strict();

const EdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
}).strict();

export const WorkflowSchema = z.object({
  version: z.literal(1),
  name: displayText(120),
  nodes: z.array(NodeSchema).max(64),
  edges: z.array(EdgeSchema).max(128),
}).strict();

export type AgentWorkflow = z.infer<typeof WorkflowSchema>;

const REQUIRES_APPROVAL = new Set<NodeType>(["asset.export"]);

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
