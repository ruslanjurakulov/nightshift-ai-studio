import { coerceQuote, coerceRun, coerceWorkflow, type RunView, type Workflow, type WorkflowQuote } from "@/lib/workflows";
import type { WorkflowDefinition } from "@/lib/workflows-builder";

/**
 * The workflow pages' calls to their routes (migration 0073). Each resolves —
 * never throws — to the route's answer or a code the page has a sentence for.
 * Nothing here decides anything and nothing here sends a price of its own:
 * the routes run the database's functions under the member's session, and
 * "Run now" carries only the total the member confirmed.
 */

export type ApiResult<T> =
  | { ok: true; value: T; status: number }
  | { ok: false; error: string; status: number; body: Record<string, unknown> };

async function call<T>(url: string, method: string, body: unknown, pick: (b: Record<string, unknown>) => T | null): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: "network", status: 0, body: {} };
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return { ok: false, error: typeof json.error === "string" ? json.error : "failed", status: res.status, body: json };
  const value = pick(json);
  return value === null ? { ok: false, error: "failed", status: res.status, body: json } : { ok: true, value, status: res.status };
}

const wf = (id: string) => `/api/workflows/${encodeURIComponent(id)}`;

export function saveWorkflow(orgId: string, name: string, def: WorkflowDefinition, id: string | null): Promise<ApiResult<Workflow>> {
  const body = { org_id: orgId, name, inputs: def.inputs, steps: def.steps };
  return call(id ? wf(id) : "/api/workflows", id ? "PATCH" : "POST", body, (b) => coerceWorkflow(b.workflow));
}

export function removeWorkflow(id: string): Promise<ApiResult<true>> {
  return call(wf(id), "DELETE", undefined, (b) => (b.ok === true ? true : null));
}

export function quoteWorkflow(id: string, inputs: Record<string, string>): Promise<ApiResult<WorkflowQuote>> {
  return call(`${wf(id)}/quote`, "POST", { inputs }, (b) => coerceQuote(b.quote));
}

/** One press of Run now: `maxCredits` is the total the member confirmed, `runId` this press's replay token. */
export function runWorkflow(
  id: string,
  runId: string,
  version: number,
  inputs: Record<string, string>,
  maxCredits: number,
): Promise<ApiResult<RunView>> {
  return call(`${wf(id)}/run`, "POST", { run_id: runId, version, inputs, max_credits: maxCredits }, (b) => coerceRun(b.run));
}

const run = (id: string) => `/api/workflows/runs/${encodeURIComponent(id)}`;

export function readRun(id: string): Promise<ApiResult<RunView>> {
  return call(run(id), "GET", undefined, (b) => coerceRun(b.run));
}
export function advanceRun(id: string): Promise<ApiResult<RunView>> {
  return call(`${run(id)}/advance`, "POST", {}, (b) => coerceRun(b.run));
}
export function cancelRun(id: string): Promise<ApiResult<RunView>> {
  return call(`${run(id)}/cancel`, "POST", {}, (b) => coerceRun(b.run));
}
