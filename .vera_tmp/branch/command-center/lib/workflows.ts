/**
 * Workflow apps (migration 0073), independent of transport and of React: the
 * types a saved workflow and its runs have, the shapes the database answers
 * with, and the rules the screens apply before they ask it anything.
 *
 * A workflow is a saved list of 2-6 creative steps with named inputs. Nothing
 * here prices, holds or decides: the price of every step comes from the
 * database (quote_workflow -> creative_price, the function behind
 * /api/creative/quote), the total is their sum — or unknown when any step
 * cannot be priced, never 0 — and "Run now" only ever carries the total the
 * person confirmed (max_credits). Whether a definition may be saved, run or
 * advanced is the database's; the checks here only keep an obviously
 * incomplete form from being sent.
 */
import type { CreativeCapability } from "@/lib/creative/operations";
import type { Dictionary } from "@/lib/i18n";
import { atLeast, type Role } from "@/lib/auth/roles-shared";
import { DEFAULT_ORG_ID } from "@/lib/orgs";

/** What a workflow's steps are built from: the Studio's own tools that make a picture, a clip or a voice. */
export const WORKFLOW_CAPABILITIES = ["t2i", "edit", "i2v", "upscale", "remove_bg", "t2v", "tts"] as const satisfies readonly CreativeCapability[];
export type WorkflowCapability = (typeof WORKFLOW_CAPABILITIES)[number];

export const MIN_STEPS = 2;
export const MAX_STEPS = 6;
export const MAX_INPUTS = 6;
export const NAME_MAX = 80;
export const LABEL_MAX = 60;
export const PROMPT_MAX = 4000;

/** Tools that start from a picture (a library file, or what an earlier step made). */
export const PICTURE_TOOLS = ["edit", "i2v", "upscale", "remove_bg"] as const;
/** Tools that leave a picture a later step may start from. */
export const PICTURE_MAKERS = ["t2i", "edit", "upscale", "remove_bg"] as const;
/** Tools that take words. */
export const PROMPT_TOOLS = ["t2i", "t2v", "tts", "edit"] as const;

export function takesPicture(c: string): boolean {
  return (PICTURE_TOOLS as readonly string[]).includes(c);
}
export function makesPicture(c: string): boolean {
  return (PICTURE_MAKERS as readonly string[]).includes(c);
}
export function takesPrompt(c: string): boolean {
  return (PROMPT_TOOLS as readonly string[]).includes(c);
}

export type InputKind = "text" | "asset";
export interface WorkflowInput {
  name: string;
  kind: InputKind;
  label?: string;
}

/** A step's parameter: a plain value, an input's name, or the picture an earlier step made. */
export type ParamValue = string | number | { $input: string } | { $step: number };
export interface WorkflowStep {
  capability: WorkflowCapability;
  model: string;
  params: Record<string, ParamValue>;
}

export interface Workflow {
  id: string;
  org_id: string;
  name: string;
  inputs: WorkflowInput[];
  steps: WorkflowStep[];
  version: number;
  created_at: string | null;
  updated_at: string | null;
}

export const WORKFLOW_COLUMNS = "id,org_id,name,inputs,steps,version,created_at,updated_at";
export const RUN_COLUMNS =
  "id,org_id,workflow_id,workflow_name,workflow_version,status,inputs,max_credits,charged_credits,error_code,error,created_at,updated_at,finished_at";

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function coerceWorkflow(row: unknown): Workflow | null {
  const r = obj(row);
  if (!r || typeof r.id !== "string" || typeof r.org_id !== "string" || typeof r.name !== "string") return null;
  if (!Array.isArray(r.steps) || !Array.isArray(r.inputs)) return null;
  const steps = r.steps.flatMap((s): WorkflowStep[] => {
    const o = obj(s);
    const params = obj(o?.params);
    if (!o || !params || typeof o.capability !== "string" || typeof o.model !== "string") return [];
    return [{ capability: o.capability as WorkflowCapability, model: o.model, params: params as WorkflowStep["params"] }];
  });
  const inputs = r.inputs.flatMap((i): WorkflowInput[] => {
    const o = obj(i);
    if (!o || typeof o.name !== "string" || (o.kind !== "text" && o.kind !== "asset")) return [];
    return [{ name: o.name, kind: o.kind, ...(typeof o.label === "string" ? { label: o.label } : {}) }];
  });
  return {
    id: r.id,
    org_id: r.org_id,
    name: r.name,
    inputs,
    steps,
    version: num(r.version) ?? 1,
    created_at: str(r.created_at),
    updated_at: str(r.updated_at),
  };
}

export function coerceWorkflows(rows: unknown): Workflow[] {
  return Array.isArray(rows) ? rows.flatMap((r) => coerceWorkflow(r) ?? []) : [];
}

// ── the price ──────────────────────────────────────────────────────────────

export interface QuoteStep {
  step_index: number;
  capability: string;
  model: string;
  priced: boolean;
  /** Null when the step is unpriced: never 0 standing in for "unknown". */
  credits: number | null;
  /** Why it has no price (the database's own word: unpriced, model_not_sellable, source_unavailable …). */
  reason: string | null;
  /** Starts from an earlier step's picture, so its price was read against a stand-in picture. */
  chained: boolean;
}

export interface WorkflowQuote {
  workflow_id: string;
  version: number;
  steps: QuoteStep[];
  /** True when every step has a price. */
  priced: boolean;
  /** The sum of the step prices; null whenever any step is unpriced. */
  total: number | null;
  unpriced_steps: number[];
  exempt: boolean;
  available: number | null;
}

/**
 * The database's quote, or null when it is not in the shape promised. A total
 * is kept only if EVERY step is priced and it really is their sum: anything
 * else is "unpriced", so a malformed answer can never become a price.
 */
export function coerceQuote(data: unknown): WorkflowQuote | null {
  const q = obj(data);
  if (!q || typeof q.workflow_id !== "string" || !Array.isArray(q.steps) || q.steps.length === 0) return null;
  const steps: QuoteStep[] = [];
  for (const s of q.steps) {
    const o = obj(s);
    if (!o) return null;
    const credits = num(o.credits);
    const priced = o.priced === true && credits !== null && credits >= 0;
    steps.push({
      step_index: num(o.step_index) ?? steps.length,
      capability: str(o.capability) ?? "",
      model: str(o.model) ?? "",
      priced,
      credits: priced ? credits : null,
      reason: priced ? null : (str(o.reason) ?? "unpriced"),
      chained: o.chained === true,
    });
  }
  const sum = steps.every((s) => s.priced) ? Math.round(steps.reduce((a, s) => a + (s.credits ?? 0), 0) * 100) / 100 : null;
  const claimed = num(q.total);
  const total = sum !== null && claimed !== null && Math.abs(claimed - sum) < 0.005 ? sum : null;
  return {
    workflow_id: q.workflow_id,
    version: num(q.version) ?? 1,
    steps,
    priced: total !== null,
    total,
    unpriced_steps: steps.filter((s) => !s.priced).map((s) => s.step_index),
    exempt: q.exempt === true,
    available: num(q.available),
  };
}

/** Run now is possible only with ONE real total, and (unless the organization is exempt) enough credits for all of it. */
export type RunBlock = "unpriced" | "insufficient" | null;
export function runBlock(q: WorkflowQuote | null): RunBlock {
  if (!q || q.total === null || !q.priced) return "unpriced";
  if (!q.exempt && q.available !== null && q.available < q.total) return "insufficient";
  return null;
}

// ── runs ───────────────────────────────────────────────────────────────────

export const STEP_STATUSES = ["pending", "running", "completed", "failed", "cancelled", "skipped"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
export const RUN_STATUSES = ["running", "completed", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunStepView {
  step_index: number;
  capability: string;
  model: string;
  status: StepStatus;
  /** null = not on record: said in words, never shown as 0. */
  quoted_credits: number | null;
  charged_credits: number | null;
  job_id: string | null;
  job_status: string | null;
  result_asset_ids: string[];
  error_code: string | null;
  error: string | null;
}

export interface RunView {
  id: string;
  org_id: string;
  workflow_id: string;
  workflow_name: string;
  status: RunStatus;
  /** null = not on record: said in words, never shown as 0 (CLAUDE.md #5). */
  max_credits: number | null;
  charged_credits: number | null;
  error_code: string | null;
  created_at: string | null;
  finished_at: string | null;
  steps: RunStepView[];
}

function oneOf<T extends string>(v: unknown, list: readonly T[], fallback: T): T {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * `{ run, steps }` as workflow_run_json answers it (the RLS reads give the same
 * two halves) — or a run already in this shape, its steps inside, which is what
 * the run routes answer (`{ run: RunView }`) and the pages read back.
 */
export function coerceRun(data: unknown): RunView | null {
  const d = obj(data);
  const r = obj(d?.run) ?? (d && typeof d.id === "string" ? d : null);
  if (!d || !r || typeof r.id !== "string" || typeof r.org_id !== "string" || typeof r.workflow_id !== "string") return null;
  const steps = (Array.isArray(d.steps) ? d.steps : []).flatMap((s): RunStepView[] => {
    const o = obj(s);
    if (!o) return [];
    return [
      {
        step_index: num(o.step_index) ?? 0,
        capability: str(o.capability) ?? "",
        model: str(o.model) ?? "",
        status: oneOf(o.status, STEP_STATUSES, "pending"),
        quoted_credits: num(o.quoted_credits),
        charged_credits: num(o.charged_credits),
        job_id: str(o.job_id),
        job_status: str(o.job_status),
        result_asset_ids: Array.isArray(o.result_asset_ids) ? o.result_asset_ids.filter((x): x is string => typeof x === "string") : [],
        error_code: str(o.error_code),
        error: str(o.error),
      },
    ];
  });
  return {
    id: r.id,
    org_id: r.org_id,
    workflow_id: r.workflow_id,
    workflow_name: str(r.workflow_name) ?? "",
    status: oneOf(r.status, RUN_STATUSES, "running"),
    max_credits: num(r.max_credits),
    charged_credits: num(r.charged_credits),
    error_code: str(r.error_code),
    created_at: str(r.created_at),
    finished_at: str(r.finished_at),
    steps: steps.sort((a, b) => a.step_index - b.step_index),
  };
}

/** One row of the recent runs list. Amounts the database did not give stay null, never 0. */
export interface RunSummary {
  id: string;
  workflow_id: string;
  workflow_name: string;
  status: string;
  max_credits: number | null;
  charged_credits: number | null;
  created_at: string | null;
}

export function coerceRunSummary(row: unknown): RunSummary | null {
  const r = obj(row);
  if (!r || typeof r.id !== "string" || typeof r.workflow_id !== "string") return null;
  return {
    id: r.id,
    workflow_id: r.workflow_id,
    workflow_name: str(r.workflow_name) ?? "",
    status: str(r.status) ?? "running",
    max_credits: num(r.max_credits),
    charged_credits: num(r.charged_credits),
    created_at: str(r.created_at),
  };
}

/**
 * May the caller carry this run on (advance, stop, run again)? Their role in
 * the RUN's organization — not the organization being viewed — at editor or
 * above. In the operator's own organization (paid by the platform) the
 * database also requires a platform owner/admin (start_workflow_run and
 * advance_workflow_run, 0073/0074), so there `platformAdmin` must be true:
 * otherwise the page would poll a refusal every few seconds (BR-L-013). An
 * unknown platform role is passed as false. Presentation only: the database
 * re-checks every call, and a later step also needs the member who confirmed
 * the run to still be allowed (0074).
 */
export function canCarryRun(
  orgs: readonly { id: string; role: Role; is_default?: boolean }[],
  runOrgId: string,
  platformAdmin = false,
): boolean {
  const mine = orgs.find((o) => o.id === runOrgId);
  if (!mine || !atLeast(mine.role, "editor")) return false;
  const operatorOrg = mine.is_default === true || mine.id === DEFAULT_ORG_ID;
  return operatorOrg ? platformAdmin === true : true;
}

/**
 * Why a step that has not started is waiting (0083, BR-L-011): everything the
 * plan may run at once is busy, or the balance is short for it. Both pass, so
 * the run stays running, holds nothing for the step, and starts it on a later
 * advance; a day after the price was confirmed it stops instead.
 */
export const WAIT_CODES = ["run_limit_reached", "insufficient_credits"] as const;
export type WaitCode = (typeof WAIT_CODES)[number];

export function stepWaitCode(step: Pick<RunStepView, "status" | "error_code">): WaitCode | null {
  return step.status === "pending" && (WAIT_CODES as readonly string[]).includes(step.error_code ?? "")
    ? (step.error_code as WaitCode)
    : null;
}

/** The step a running run is waiting on, if any. */
export function waitingStep(run: Pick<RunView, "status" | "steps">): (RunStepView & { wait: WaitCode }) | null {
  if (run.status !== "running") return null;
  for (const s of run.steps) {
    const wait = stepWaitCode(s);
    if (wait) return { ...s, wait };
  }
  return null;
}

/** How long a confirmed price may still start steps (0073's confirmation_expired). */
export const CONFIRMATION_MS = 24 * 60 * 60 * 1000;

/** When a waiting run stops if its step has not started: the confirmation plus a day. Null when not on record. */
export function confirmationDeadline(run: Pick<RunView, "created_at">): Date | null {
  if (!run.created_at) return null;
  const t = Date.parse(run.created_at);
  return Number.isFinite(t) ? new Date(t + CONFIRMATION_MS) : null;
}

export function isRunActive(run: Pick<RunView, "status"> | null | undefined): boolean {
  return run?.status === "running";
}

/** How long the run page waits between asking the database to carry the run on. */
export const ADVANCE_EVERY_MS = 4000;

/** A fresh run id: the replay token of one press of Run now. */
export function newRunId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`;
}

/** The inputs a person fills in before Run now, by the names the steps use. */
export function emptyValues(inputs: readonly WorkflowInput[]): Record<string, string> {
  return Object.fromEntries(inputs.map((i) => [i.name, ""]));
}

/** Every declared input given something, text within the prompt limit — or the first problem. */
export function valuesProblem(inputs: readonly WorkflowInput[], values: Record<string, string>): "missing" | "too_long" | null {
  for (const i of inputs) {
    const v = (values[i.name] ?? "").trim();
    if (!v) return "missing";
    if (v.length > PROMPT_MAX) return "too_long";
  }
  return null;
}

/** The label a person sees for an input (their own words, or a plain default from its name). */
export function inputLabel(i: WorkflowInput): string {
  return i.label?.trim() || i.name.replace(/_/g, " ");
}

/** A route's error code -> the sentence the person reads (never the code itself). */
export function workflowErrorMessage(t: Dictionary, code: unknown): string {
  const own = t.workflows.errors as Record<string, string>;
  const creative = t.creative.errors as Record<string, string>;
  if (typeof code === "string") {
    if (own[code]) return own[code];
    if (creative[code]) return creative[code];
  }
  return creative.failed;
}

/** Why a step stopped, in words: the database's code -> a clause that completes "This step stopped: …". */
export function stepFailureReason(t: Dictionary, code: string | null): string {
  const m = t.workflows.stepErrors as Record<string, string>;
  return (code && m[code]) || m.other;
}
