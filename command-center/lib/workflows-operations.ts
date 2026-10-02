/**
 * Workflow apps (migration 0073), independent of transport: the routes under
 * /api/workflows call these with the signed-in user's own database door.
 *
 * Input is shape-checked here so a malformed request never reaches the
 * database; everything that decides — membership and the member's role, the
 * price of each step, that the confirmed total is the total, the hold of each
 * step (made by the ordinary creative job, only when that step starts), the
 * replay of a run id — is decided by 0073's security-definer functions through
 * `db.rpc`, under the signed-in user's session with the ANON key. Nothing here
 * holds a service key, talks to a provider or publishes anything.
 *
 * Pure apart from the injected `db`, so it is unit-tested with a fake one.
 */
import {
  isUuid,
  mapCreativeError,
  type CreativeResult,
  type DbAnswer,
  type DbError,
} from "@/lib/creative/operations";
import { LABEL_MAX, MAX_INPUTS, MAX_STEPS, MIN_STEPS, NAME_MAX, coerceQuote, coerceRun, coerceWorkflow } from "@/lib/workflows";

export interface WorkflowDb {
  rpc(fn: string, args: Record<string, unknown>): Promise<DbAnswer>;
  /** The organization's workflows (RLS: its members), newest edit first. */
  listWorkflows(orgId: string): Promise<DbAnswer>;
  readWorkflow(id: string): Promise<DbAnswer>;
  /** One run and its steps, read through RLS. */
  readRun(id: string): Promise<DbAnswer>;
  /** The newest runs of an organization (optionally of one workflow). */
  listRuns(orgId: string, workflowId: string | null, limit: number): Promise<DbAnswer>;
}

/** Codes the routes answer with beyond the creative ones; each has a sentence in lib/i18n `workflows.errors`. */
export const WORKFLOW_ERRORS = [
  "invalid_inputs",
  "workflow_changed",
  "limit_reached",
  "run_conflict",
  "invalid_workflow",
  "workflows_unavailable",
] as const;
export type WorkflowError = (typeof WORKFLOW_ERRORS)[number];

export function isWorkflowError(code: unknown): code is WorkflowError {
  return typeof code === "string" && (WORKFLOW_ERRORS as readonly string[]).includes(code);
}

function fail(status: number, error: string, extra: Record<string, unknown> = {}): CreativeResult {
  return { status, body: { error, ...extra } };
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 0073 not applied (or a function renamed): "not enabled here", never a crash or a zero. */
export function isWorkflowMissing(error: DbError | null | undefined): boolean {
  if (!error) return false;
  return (
    error.code === "PGRST202" ||
    error.code === "PGRST205" ||
    error.code === "42883" ||
    error.code === "42P01" ||
    /could not find the (function|table)|does not exist/i.test(error.message ?? "")
  );
}

/** A database refusal -> the route's answer. The creative refusals keep their codes; the workflow ones are added. */
export function mapWorkflowError(error: DbError): CreativeResult {
  if (isWorkflowMissing(error)) return fail(503, "workflows_unavailable");
  const word = (error.message ?? "").trim();
  const detail = typeof error.details === "string" && error.details ? error.details.slice(0, 300) : undefined;
  const extra = detail ? { detail } : {};
  if (error.code === "NS400") {
    if (word === "invalid_inputs") return fail(400, "invalid_inputs", extra);
    if (word === "limit_reached") return fail(409, "limit_reached", extra);
    if (word === "confirm_price") return fail(400, "confirm_price");
    if (word === "invalid_params") return fail(400, "invalid_workflow", extra);
  }
  if (error.code === "NS409") {
    if (word === "workflow_changed") return fail(409, "workflow_changed", extra);
    if (word === "idempotency_conflict") return fail(409, "run_conflict");
  }
  if (error.code === "42501" || error.code === "P0002" || error.code === "NS402" || error.code === "NS429" ||
      error.code === "NS400" || error.code === "NS409") {
    return mapCreativeError(error);
  }
  return fail(502, "failed");
}

export interface SaveInput {
  orgId: string;
  name: string;
  inputs: unknown[];
  steps: unknown[];
}

/**
 * A save body -> the input, or the 400. Only the outer shape is checked (a
 * name, at most 6 inputs, 2-6 steps): what a step means is the database's rule,
 * the same one the Studio's generations obey.
 */
export function parseSaveInput(
  body: unknown,
  defaultOrg: string | null,
): { ok: true; input: SaveInput } | { ok: false; result: CreativeResult } {
  const b = obj(body);
  if (!b) return { ok: false, result: fail(400, "invalid_body") };
  const unknown = Object.keys(b).filter((k) => !["org_id", "name", "inputs", "steps"].includes(k));
  if (unknown.length) return { ok: false, result: fail(400, "invalid_body", { detail: `unknown field(s): ${unknown.join(", ")}` }) };
  const orgId = b.org_id == null ? defaultOrg : b.org_id;
  if (!isUuid(orgId)) return { ok: false, result: fail(400, "org_required") };
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > NAME_MAX) return { ok: false, result: fail(400, "invalid_workflow", { detail: "name" }) };
  const inputs = b.inputs === undefined ? [] : b.inputs;
  if (!Array.isArray(inputs) || inputs.length > MAX_INPUTS) return { ok: false, result: fail(400, "invalid_workflow", { detail: "inputs" }) };
  for (const i of inputs) {
    const o = obj(i);
    if (!o || (typeof o.label === "string" && o.label.length > LABEL_MAX))
      return { ok: false, result: fail(400, "invalid_workflow", { detail: "inputs" }) };
  }
  if (!Array.isArray(b.steps) || b.steps.length < MIN_STEPS || b.steps.length > MAX_STEPS)
    return { ok: false, result: fail(400, "invalid_workflow", { detail: "steps" }) };
  return { ok: true, input: { orgId, name, inputs, steps: b.steps } };
}

export async function saveWorkflow(db: WorkflowDb, input: SaveInput, workflowId: string | null): Promise<CreativeResult> {
  if (workflowId !== null && !isUuid(workflowId)) return fail(404, "not_found");
  const { data, error } = await db.rpc("save_workflow", {
    p_org: input.orgId,
    p_workflow: workflowId,
    p_name: input.name,
    p_inputs: input.inputs,
    p_steps: input.steps,
  });
  if (error) return mapWorkflowError(error);
  const wf = coerceWorkflow(data);
  if (!wf) return fail(502, "failed");
  return { status: workflowId ? 200 : 201, body: { workflow: wf } };
}

export async function deleteWorkflow(db: WorkflowDb, id: string): Promise<CreativeResult> {
  if (!isUuid(id)) return fail(404, "not_found");
  const { error } = await db.rpc("delete_workflow", { p_workflow: id });
  if (error) return mapWorkflowError(error);
  return { status: 200, body: { ok: true } };
}

function cleanValues(v: unknown): Record<string, string> | null {
  if (v === undefined || v === null) return {};
  const o = obj(v);
  if (!o) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(o)) {
    if (typeof val !== "string") return null;
    out[k] = val;
  }
  return out;
}

/** What Run now would cost, before anything is held: every step's own price and ONE total (or none). */
export async function quoteWorkflow(db: WorkflowDb, id: string, rawInputs: unknown): Promise<CreativeResult> {
  if (!isUuid(id)) return fail(404, "not_found");
  const inputs = cleanValues(rawInputs);
  if (!inputs) return fail(400, "invalid_inputs");
  const { data, error } = await db.rpc("quote_workflow", { p_workflow: id, p_inputs: inputs });
  if (error) return mapWorkflowError(error);
  const q = coerceQuote(data);
  if (!q) return fail(502, "failed");
  return { status: 200, body: { quote: q } };
}

export interface RunInput {
  runId: string;
  version: number;
  inputs: Record<string, string>;
  maxCredits: number;
}

/**
 * A Run now body -> the input, or the 400. `max_credits` is the total the
 * member confirmed and is required — a missing one is `confirm_price`, never a
 * default; `run_id` is the press's replay token, chosen by the page.
 */
export function parseRunInput(body: unknown): { ok: true; input: RunInput } | { ok: false; result: CreativeResult } {
  const b = obj(body);
  if (!b) return { ok: false, result: fail(400, "invalid_body") };
  const unknown = Object.keys(b).filter((k) => !["run_id", "version", "inputs", "max_credits"].includes(k));
  if (unknown.length) return { ok: false, result: fail(400, "invalid_body", { detail: `unknown field(s): ${unknown.join(", ")}` }) };
  if (!isUuid(b.run_id)) return { ok: false, result: fail(400, "invalid_body", { detail: "run_id" }) };
  if (typeof b.version !== "number" || !Number.isInteger(b.version) || b.version < 1)
    return { ok: false, result: fail(400, "invalid_body", { detail: "version" }) };
  const inputs = cleanValues(b.inputs);
  if (!inputs) return { ok: false, result: fail(400, "invalid_inputs") };
  const mc = b.max_credits;
  if (typeof mc !== "number" || !Number.isFinite(mc) || mc < 0) return { ok: false, result: fail(400, "confirm_price") };
  return { ok: true, input: { runId: b.run_id, version: b.version, inputs, maxCredits: mc } };
}

export async function startRun(db: WorkflowDb, workflowId: string, input: RunInput): Promise<CreativeResult> {
  if (!isUuid(workflowId)) return fail(404, "not_found");
  const { data, error } = await db.rpc("start_workflow_run", {
    p_run: input.runId,
    p_workflow: workflowId,
    p_version: input.version,
    p_inputs: input.inputs,
    p_max_credits: input.maxCredits,
  });
  if (error) return mapWorkflowError(error);
  const run = coerceRun(data);
  if (!run) return fail(502, "failed");
  const replay = obj(data)?.replay === true;
  return { status: replay ? 200 : 201, body: { run, replay } };
}

async function runCall(db: WorkflowDb, fn: "advance_workflow_run" | "cancel_workflow_run", id: string): Promise<CreativeResult> {
  if (!isUuid(id)) return fail(404, "not_found");
  const { data, error } = await db.rpc(fn, { p_run: id });
  if (error) return mapWorkflowError(error);
  const run = coerceRun(data);
  if (!run) return fail(502, "failed");
  return { status: 200, body: { run } };
}

/** Carry a run on: settle the step that finished and start the next. Safe to call as often as the page likes. */
export function advanceRun(db: WorkflowDb, id: string): Promise<CreativeResult> {
  return runCall(db, "advance_workflow_run", id);
}

export function cancelRun(db: WorkflowDb, id: string): Promise<CreativeResult> {
  return runCall(db, "cancel_workflow_run", id);
}

/** A run as the database shows it to this member, without moving it (a viewer's read). */
export async function getRun(db: WorkflowDb, id: string): Promise<CreativeResult> {
  if (!isUuid(id)) return fail(404, "not_found");
  const { data, error } = await db.readRun(id);
  if (error) return isWorkflowMissing(error) ? fail(503, "workflows_unavailable") : fail(502, "failed");
  // RLS hides another organization's run: it reads as missing, never as forbidden.
  const run = coerceRun(data);
  if (!run) return fail(404, "not_found");
  return { status: 200, body: { run } };
}
