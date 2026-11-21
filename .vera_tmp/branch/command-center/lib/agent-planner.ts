/**
 * Offline Agent Planner v0.1: constrained intent -> inspected draft DAG.
 * No LLM, network calls, credentials, costs, execution or publishing.
 * A real model-generated planner must feed the SAME validated contract.
 */
import { createCampaignWorkflow, inspectWorkflow, type AgentWorkflow, type NodeType } from "./agent-graph";

export type CreativeIntent = "image" | "video" | "vector";
export type PlannerResult = { ok: true; intent: CreativeIntent; workflow: AgentWorkflow; warnings: string[] }
  | { ok: false; error: "empty_request" | "ambiguous_intent" | "unsupported_request" | "invalid_plan" };

const TOKENS: Record<CreativeIntent, readonly RegExp[]> = {
  image: [/\b(images?|photos?|ads?|banners?|posters?|rasm|reklama)\b/i],
  video: [/\b(videos?|reels?|shorts?|clips?|video|rolik)\b/i],
  vector: [/\b(svg|vectors?|logos?|icons?|vektor|logotip)\b/i],
};

function detect(request: string): CreativeIntent[] {
  return (Object.keys(TOKENS) as CreativeIntent[]).filter(kind =>
    TOKENS[kind].some(pattern => pattern.test(request)));
}

/** No inference that might secretly choose a paid API model. */
export function planCreativeRequest(request: string, explicit?: CreativeIntent): PlannerResult {
  const trimmed = request.trim();
  if (!trimmed) return { ok: false, error: "empty_request" };
  if (trimmed.length > 500) return { ok: false, error: "unsupported_request" };
  const detected = detect(trimmed);
  if (!explicit && detected.length !== 1)
    return { ok: false, error: detected.length === 0 ? "unsupported_request" : "ambiguous_intent" };
  const intent: CreativeIntent = explicit || detected[0];

  const nodeType: NodeType = intent === "vector" ? "vector.generate" : intent === "video" ? "video.generate" : "image.generate";
  const graph = createCampaignWorkflow();
  graph.name = "Draft: " + intent + " campaign";
  graph.nodes = graph.nodes.map(n =>
    n.id === "image" ? { ...n, id: "creative", type: nodeType, label: (intent === "vector" ? "SVG" : intent === "video" ? "Video" : "Image") + " generation placeholder" } : n);
  graph.edges = graph.edges.map(edge => ({
    source: edge.source === "image" ? "creative" : edge.source,
    target: edge.target === "image" ? "creative" : edge.target,
  }));
  const checked = inspectWorkflow(graph);
  if (!checked.ok) return { ok: false, error: "invalid_plan" };
  return {
    ok: true, intent, workflow: graph,
    warnings: [
      "This is an editable graph template, not an executable instruction.",
      "No model/provider selected and no credits quoted or charged.",
      "Human review is a structural prerequisite; actual authorization is checked at runtime.",
      ...(detected.length > 1 ? ["Multiple media types were mentioned: only the explicitly selected type was planned."] : []),
    ],
  };
}
