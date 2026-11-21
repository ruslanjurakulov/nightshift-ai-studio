/** Review-only local contract, deliberately unwired. A valid projection is never a dispatch permit. */
import { z } from "zod";
import { inspectWorkflow } from "./agent-graph";

const word = z.string().min(1).max(256);
const uint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Binding = z.object({ orgId: word, taskId: word, planRevision: word, inputRevision: word, fence: uint }).strict();
const Step = z.object({
  id: word,
  status: z.enum(["queued", "running", "provider_pending", "outcome_unknown", "completed", "failed", "cancelled"]),
  attempt: uint,
  providerTaskId: word.nullable(),
  outcome: z.enum(["not_sent", "known", "unknown"]),
  failureKind: z.enum(["none", "technical", "terminal"]),
}).strict();
const Snapshot = z.object({ binding: Binding, steps: z.array(Step).max(64) }).strict();
const Limits = z.object({ maxAttempts: uint.refine(n => n > 0), deadlineMs: uint, nowMs: uint }).strict();
export type ExecutionSnapshot = z.infer<typeof Snapshot>;
type Inspection = { ok: boolean; order: string[] };
export type DagInspector = (workflow: unknown) => Inspection;
export type Verdict = { ok: boolean; reason: string; dispatchAllowed: false };
const verdict = (reason = "ok"): Verdict => ({ ok: reason === "ok", reason, dispatchAllowed: false });

/** Caller supplies a trusted immutable projection and expected scope/fence; this checks consistency only. */
export function inspectExecution(workflow: unknown, input: unknown, expected: unknown,
  inspect: DagInspector = inspectWorkflow): Verdict {
  const parsed = Snapshot.safeParse(input), binding = Binding.safeParse(expected);
  if (!parsed.success || !binding.success) return verdict("invalid_snapshot");
  let dag: Inspection;
  try { dag = inspect(workflow); } catch { return verdict("invalid_dag"); }
  if (!dag.ok || !Array.isArray(dag.order) || !dag.order.length || new Set(dag.order).size !== dag.order.length)
    return verdict("invalid_dag");
  const { steps } = parsed.data;
  if (Object.keys(binding.data).some(k => binding.data[k as keyof typeof binding.data] !== parsed.data.binding[k as keyof typeof binding.data]))
    return verdict("binding_mismatch");
  const byId = new Map(steps.map(s => [s.id, s]));
  if (byId.size !== steps.length || steps.length !== dag.order.length || dag.order.some(id => !byId.has(id)))
    return verdict("step_set_mismatch");
  // Inspectors must validate this existing graph shape; fail closed if its structural projection is absent.
  const edges = z.array(z.object({ source: word, target: word }).strict()).max(128)
    .safeParse((workflow as { edges?: unknown } | null)?.edges);
  if (!edges.success) return verdict("invalid_dag");
  for (const e of edges.data) {
    if (!byId.has(e.source) || !byId.has(e.target)) return verdict("invalid_dag");
    if (["running", "provider_pending", "outcome_unknown", "completed"].includes(byId.get(e.target)!.status)
      && byId.get(e.source)!.status !== "completed") return verdict("dependency_incomplete");
  }
  for (const step of steps) {
    if ((step.status === "failed") !== (step.failureKind !== "none")) return verdict("invalid_step_state");
    if (step.status === "queued") {
      if (step.attempt !== 0 || step.outcome !== "not_sent" || step.providerTaskId !== null) return verdict("invalid_step_state");
    } else if (step.attempt < 1) return verdict("invalid_step_state");
    if (step.status === "running" && (step.outcome !== "not_sent" || step.providerTaskId !== null)) return verdict("invalid_step_state");
    if (step.status === "provider_pending" && (step.outcome !== "known" || !step.providerTaskId)) return verdict("invalid_step_state");
    if ((step.status === "outcome_unknown") !== (step.outcome === "unknown")) return verdict("invalid_step_state");
    if (["completed", "failed", "cancelled"].includes(step.status) && step.outcome !== "known") return verdict("invalid_step_state");
  }
  return verdict();
}

/** Checks a single proposed local state change. No clock, storage, callback, provider or job is executed. */
export function inspectStepTransition(workflow: unknown, before: unknown, after: unknown,
  expected: unknown, limits: unknown, inspect: DagInspector = inspectWorkflow): Verdict {
  const prior = inspectExecution(workflow, before, expected, inspect);
  if (!prior.ok) return prior;
  const next = inspectExecution(workflow, after, expected, inspect);
  if (!next.ok) return next;
  const cap = Limits.safeParse(limits);
  if (!cap.success) return verdict("missing_or_invalid_limits");
  const a = Snapshot.parse(before), b = Snapshot.parse(after);
  if ([...a.steps, ...b.steps].some(s => s.attempt > cap.data.maxAttempts)) return verdict("attempt_limit");
  const changed = b.steps.filter(s => JSON.stringify(s) !== JSON.stringify(a.steps.find(p => p.id === s.id)));
  if (!changed.length) return verdict(); // An identical projection replays without another attempt.
  if (changed.length !== 1) return verdict("multiple_step_changes");
  const s = changed[0], p = a.steps.find(x => x.id === s.id)!;
  if (s.status === "running") {
    if (!["queued", "failed"].includes(p.status) || p.outcome === "unknown") return verdict("retry_requires_known_failure");
    if (p.status === "failed" && p.failureKind !== "technical") return verdict("non_retryable_failure");
    if (s.attempt !== p.attempt + 1) return verdict("attempt_mismatch");
    if (cap.data.nowMs >= cap.data.deadlineMs) return verdict("deadline");
    return verdict();
  }
  if (p.attempt !== s.attempt) return verdict("attempt_mismatch");
  if (p.providerTaskId !== null && p.providerTaskId !== s.providerTaskId) return verdict("provider_identity_changed");
  const allowed: Record<string, readonly string[]> = {
    running: ["provider_pending", "outcome_unknown", "completed", "failed", "cancelled"],
    provider_pending: ["outcome_unknown", "completed", "failed", "cancelled"],
    outcome_unknown: ["provider_pending", "completed", "failed", "cancelled"],
  };
  if (!allowed[p.status]?.includes(s.status)) return verdict("invalid_transition");
  // Unknown -> terminal is accepted only as an externally verified readback projection, never synthesized here.
  return verdict();
}
