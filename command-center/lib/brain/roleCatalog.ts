/**
 * Offline reference catalog for #795's P0 specification, not a runtime/tool registry or authorization policy.
 * Existing domain source and Studio overlap are review pointers only. No role is enabled or dispatched.
 * Schema/budget/approval/broker integration remains proposed; the documented ceiling grants nothing here.
 */
export const BRAIN_REGISTRY_SOURCE = Object.freeze({
  path: "docs/AI_AGENT_REGISTRY.md",
  ref: "6c61d962086e1940b9c52ad27c5b6a72991f9605",
  blob: "2bef9450cbcc54192fe9134f6be4782d9f2580a8",
  sourceRef: "0940d532d4276f049dfeef4c31c8b99106c5297a",
  phase: "P0-reference-only",
} as const);

export const BRAIN_ROLE_IDS = Object.freeze([
  "director", "script_writer", "prompt_engineer", "storyboard_designer", "researcher", "channel_analyst",
  "content_strategist", "video_editor", "quality_inspector", "publisher", "audience_manager", "comment_manager",
  "brand_manager", "character_manager", "model_router", "cost_optimizer", "customer_support",
  "financial_controller", "system_monitor", "learning_agent", "developer_auditor",
] as const);
export type BrainRoleId = (typeof BRAIN_ROLE_IDS)[number];
export type SourceStatus = "existing-domain-source" | "proposed-only" | "development-helper-only";
export type DocumentedCeiling = "R/P" | "R/P/E";

const NOOP_CAPABILITIES = Object.freeze([
  Object.freeze({ id: "context-summary", dispatch: "none" } as const),
  Object.freeze({ id: "proposal-draft", dispatch: "none" } as const),
]);

export interface BrainRoleReference {
  readonly id: BrainRoleId;
  readonly name: string;
  readonly proposal: string;
  readonly runtime: "proposed";
  readonly enabled: false;
  readonly dispatch: "none";
  readonly capabilities: typeof NOOP_CAPABILITIES;
  readonly documentedCeiling: DocumentedCeiling;
  readonly sourceStatus: SourceStatus;
  readonly sourcePaths: readonly string[];
  readonly studioOverlap: readonly string[];
}

function reference(id: BrainRoleId, name: string, proposal: string, documentedCeiling: DocumentedCeiling,
  sourcePaths: readonly string[], studioOverlap: readonly string[], sourceStatus: SourceStatus = "existing-domain-source"): BrainRoleReference {
  return Object.freeze({ id, name, proposal, runtime: "proposed", enabled: false, dispatch: "none",
    capabilities: NOOP_CAPABILITIES, documentedCeiling, sourceStatus,
    sourcePaths: Object.freeze([...sourcePaths]), studioOverlap: Object.freeze([...studioOverlap]) });
}

/** All twenty-one roles are proposed Brain roles, even where their underlying product feature already exists. */
export const BRAIN_ROLE_CATALOG: readonly BrainRoleReference[] = Object.freeze([
  reference("director", "AI Director", "creative brief and scene dependency proposal", "R/P",
    ["modules/agent_planner.py", "modules/director.py", "command-center/lib/agent-planner.ts"], ["Storyboard planning", "Film project draft"]),
  reference("script_writer", "AI Script Writer", "versioned script and sourced claims", "R/P",
    ["modules/script_engine.py", "command-center/lib/storyboard.ts"], ["Storyboard narration editing"]),
  reference("prompt_engineer", "AI Prompt Engineer", "per-scene prompt and parameter draft", "R/P",
    ["command-center/lib/creative/operations.ts", "modules/learning_memory.py"], ["Existing composer capability schemas and prompts"]),
  reference("storyboard_designer", "AI Storyboard Designer", "validated scene and shot-plan draft", "R/P",
    ["command-center/lib/films.ts", "command-center/lib/storyboardReview.ts"], ["Film scenes", "Storyboard review"]),
  reference("researcher", "AI Researcher", "evidence and uncertainty report", "R/P",
    ["modules/research_engine.py"], ["Pipeline research source; no new Studio retrieval action"]),
  reference("channel_analyst", "AI Channel Analyst", "measured findings with coverage", "R/P",
    ["modules/analytics_client.py", "modules/retention_analyzer.py", "command-center/lib/sceneRetention.ts"], ["Scene retention and analytics views"]),
  reference("content_strategist", "AI Content Strategist", "ranked ideas and strategy revision", "R/P",
    ["modules/strategy.py", "modules/audience_demand.py"], ["Existing planning and demand source"]),
  reference("video_editor", "AI Video Editor", "structured edit and export proposal", "R/P/E",
    ["command-center/lib/editor.ts", "command-center/components/editor/TimelineEditor.tsx"], ["Existing edit validators and export; no export dispatch here"]),
  reference("quality_inspector", "AI Quality Inspector", "QC findings and review recommendation", "R/P",
    ["modules/video_qc.py", "modules/publish_gate.py"], ["QC and publish review; no gate override"]),
  reference("publisher", "AI Publisher", "exact-cut publish recommendation", "R/P/E",
    ["command-center/lib/publish.ts", "modules/publish_approval.py"], ["Existing approval/publish boundary; no publish dispatch here"]),
  reference("audience_manager", "AI Audience Manager", "aggregate questions and escalation draft", "R/P",
    ["modules/audience_demand.py", "modules/comment_intelligence.py"], ["Audience and comment analysis; no messaging"]),
  reference("comment_manager", "AI Comment Manager", "comment classification or reply draft", "R/P/E",
    ["command-center/lib/comment-inbox.ts", "modules/comment_replies.py"], ["Existing comment inbox approval path; no reply dispatch here"]),
  reference("brand_manager", "AI Brand Manager", "brand and tone revision proposal", "R/P",
    ["command-center/lib/channel-dna.ts", "command-center/lib/style-kits.ts"], ["Channel DNA and style kits"]),
  reference("character_manager", "AI Character Manager", "character consistency proposal", "R/P",
    ["command-center/components/agents/CastEditor.tsx"], ["Existing cast editor; generation is separate"]),
  reference("model_router", "AI Model Router", "eligible model recommendation", "R/P",
    ["command-center/lib/creative/registry.ts", "command-center/lib/models-discovery.ts"], ["Existing model catalog; no router or availability change"]),
  reference("cost_optimizer", "AI Cost Optimizer", "cost, speed and quality alternatives", "R/P",
    ["modules/cost_ledger.py", "command-center/lib/credits.ts"], ["Existing cost/credit source; private-cost visibility remains a separate concern"]),
  reference("customer_support", "AI Customer Support", "approved-help answer or escalation draft", "R/P",
    [], ["Proposed support corpus/adapter; no Studio account or payment action"], "proposed-only"),
  reference("financial_controller", "AI Financial Controller", "admin-scoped variance and margin report", "R/P",
    ["modules/cost_ledger.py", "command-center/lib/billing.ts"], ["Existing reconciliation/cost source; no payment, refund or ledger operation"]),
  reference("system_monitor", "AI System Monitor", "sanitized health and incident proposal", "R/P",
    ["modules/resource_monitor.py"], ["Existing resource monitoring source; sanitized broker remains proposed"]),
  reference("learning_agent", "AI Learning Agent", "pending evidence-backed learning", "R/P",
    ["modules/learning_memory.py", "command-center/lib/learnings.ts"], ["Existing learning approval flow; no automatic approval"]),
  reference("developer_auditor", "AI Developer Auditor", "read-only source review report", "R/P",
    [".claude/agents/lens.md"], ["Development helper only; no deployed Brain code tools"], "development-helper-only"),
]);

/** Exact stable IDs only. An unregistered role never inherits another role's metadata or tools. */
export function brainRoleReference(id: string): BrainRoleReference | null {
  return BRAIN_ROLE_CATALOG.find((role) => role.id === id) ?? null;
}
