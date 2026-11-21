import { describe, expect, it, vi } from "vitest";
import { inspectWorkflow } from "../lib/agent-graph";
import { inspectExecution, inspectStepTransition, type ExecutionSnapshot } from "../lib/brain-execution-contract";

const binding = { orgId: "synthetic-org", taskId: "synthetic-task", planRevision: "plan-v1", inputRevision: "input-v1", fence: 7 };
const workflow = { version: 1, name: "Local only", nodes: [
  { id: "first", type: "prompt.compose", label: "First", config: {} },
  { id: "second", type: "image.generate", label: "Second", config: {} },
], edges: [{ source: "first", target: "second" }] };
const limits = { maxAttempts: 2, deadlineMs: 200, nowMs: 100 }; // Synthetic caller policy, no production defaults.
const queued = (): ExecutionSnapshot => ({ binding: { ...binding }, steps: ["first", "second"].map(id =>
  ({ id, status: "queued", attempt: 0, providerTaskId: null, outcome: "not_sent", failureKind: "none" })) });
const set = (s: ExecutionSnapshot, changes: Partial<ExecutionSnapshot["steps"][number]>, id = "first") =>
  ({ ...s, steps: s.steps.map(step => step.id === id ? { ...step, ...changes } : step) });
const running = () => set(queued(), { status: "running", attempt: 1 });
const failed = () => set(running(), { status: "failed", outcome: "known", failureKind: "technical" });
const unknown = () => set(running(), { status: "outcome_unknown", outcome: "unknown" });
const check = (a: unknown, b: unknown, cap: unknown = limits) => inspectStepTransition(workflow, a, b, binding, cap);

describe("review-only execution projections", () => {
  it("reuses the existing injected DAG inspector and grants no dispatch", () => {
    const inspect = vi.fn(inspectWorkflow);
    expect(inspectExecution(workflow, queued(), binding, inspect)).toEqual({ ok: true, reason: "ok", dispatchAllowed: false });
    expect(inspect).toHaveBeenCalledWith(workflow);
  });
  it("rejects invalid/cyclic graphs and failed/throwing inspectors", () => {
    expect(inspectExecution({ ...workflow, edges: [...workflow.edges, { source: "second", target: "first" }] }, queued(), binding).ok).toBe(false);
    expect(inspectExecution(workflow, queued(), binding, () => { throw Error("synthetic"); }).reason).toBe("invalid_dag");
    expect(inspectExecution(workflow, queued(), binding, () => ({ ok: false, order: [] })).ok).toBe(false);
  });
  it.each(["orgId", "taskId", "planRevision", "inputRevision", "fence"] as const)("rejects stale or changed %s", key => {
    const s = queued(); Object.assign(s.binding, { [key]: key === "fence" ? 8 : "changed" });
    expect(inspectExecution(workflow, s, binding).reason).toBe("binding_mismatch");
  });
  it.each([null, {}, { ...queued(), extra: true }, { ...queued(), steps: [] }, { ...queued(), steps: [queued().steps[0], queued().steps[0]] }])("rejects malformed/missing/duplicate step projections %#", s => {
    expect(inspectExecution(workflow, s, binding).ok).toBe(false);
  });
  it("requires all predecessors completed before starting a dependent step", () => {
    expect(check(queued(), set(queued(), { status: "running", attempt: 1 }, "second")).reason).toBe("dependency_incomplete");
    const done = set(running(), { status: "completed", outcome: "known" });
    expect(check(done, set(done, { status: "running", attempt: 1 }, "second")).ok).toBe(true);
  });
  it("starts at attempt one and permits only bounded known-failure retries", () => {
    expect(check(queued(), running()).ok).toBe(true);
    expect(check(failed(), set(failed(), { status: "running", outcome: "not_sent", failureKind: "none", attempt: 2 })).ok).toBe(true);
    const exhausted = set(failed(), { attempt: 2 });
    expect(check(exhausted, set(exhausted, { status: "running", outcome: "not_sent", failureKind: "none", attempt: 3 })).reason).toBe("attempt_limit");
    expect(check(failed(), set(failed(), { status: "running", outcome: "not_sent", failureKind: "none", attempt: 1 })).reason).toBe("attempt_mismatch");
  });
  it("never retries a known terminal rejection as a technical failure", () => {
    const terminal = set(failed(), { failureKind: "terminal" });
    expect(check(terminal, set(terminal, { status: "running", outcome: "not_sent", failureKind: "none", attempt: 2 })).reason).toBe("non_retryable_failure");
  });
  it.each([null, {}, { ...limits, maxAttempts: 0 }, { ...limits, nowMs: NaN }, { ...limits, deadlineMs: Infinity }])("rejects missing or malformed explicit retry limits %#", cap => {
    expect(check(queued(), running(), cap).reason).toBe("missing_or_invalid_limits");
  });
  it("blocks new attempts at the deadline but permits same-task reconciliation", () => {
    const expired = { ...limits, nowMs: 200 };
    expect(check(queued(), running(), expired).reason).toBe("deadline");
    expect(check(unknown(), set(unknown(), { status: "failed", outcome: "known", failureKind: "technical" }), expired).ok).toBe(true);
  });
  it("makes unknown provider outcomes explicit and refuses blind repeat purchase", () => {
    expect(check(running(), unknown()).ok).toBe(true);
    expect(check(unknown(), set(unknown(), { status: "running", attempt: 2, outcome: "not_sent" })).reason).toBe("retry_requires_known_failure");
    expect(inspectExecution(workflow, set(unknown(), { status: "failed" }), binding).ok).toBe(false);
    expect(inspectExecution(workflow, set(running(), { outcome: "unknown" }), binding).ok).toBe(false);
  });
  it("requires provider identity for pending, preserves it during reconciliation", () => {
    expect(check(running(), set(running(), { status: "provider_pending", outcome: "known" })).ok).toBe(false);
    const pending = set(running(), { status: "provider_pending", outcome: "known", providerTaskId: "fake-provider-task" });
    expect(check(running(), pending).ok).toBe(true);
    const u = set(pending, { status: "outcome_unknown", outcome: "unknown" });
    expect(check(pending, u).ok).toBe(true);
    expect(check(u, pending).ok).toBe(true);
    expect(check(u, set(pending, { providerTaskId: "other-task" })).reason).toBe("provider_identity_changed");
  });
  it.each(["completed", "cancelled"] as const)("keeps %s terminal and exact replay inert", status => {
    const terminal = set(running(), { status, outcome: "known" });
    expect(check(terminal, structuredClone(terminal))).toEqual({ ok: true, reason: "ok", dispatchAllowed: false });
    expect(check(terminal, set(terminal, { status: "running", outcome: "not_sent", failureKind: "none", attempt: 2 })).ok).toBe(false);
  });
  it("does not mutate snapshots or allow a multi-step jump", () => {
    const a = running(), b = set(a, { status: "completed", outcome: "known" });
    const saved = JSON.stringify([a, b, workflow]);
    expect(check(a, b).ok).toBe(true); expect(JSON.stringify([a, b, workflow])).toBe(saved);
    expect(check(a, set(b, { status: "running", attempt: 1 }, "second")).reason).toBe("multiple_step_changes");
  });
});
