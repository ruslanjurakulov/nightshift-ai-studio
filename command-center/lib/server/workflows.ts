import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient, getUser } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { isUuid, type CreativeResult } from "@/lib/creative/operations";
import { isWorkflowMissing, type WorkflowDb } from "@/lib/workflows-operations";
import {
  RUN_COLUMNS,
  WORKFLOW_COLUMNS,
  coerceRun,
  coerceWorkflow,
  coerceWorkflows,
  type RunView,
  type Workflow,
} from "@/lib/workflows";

/**
 * The workflow operations' database door for the web: the signed-in user's own
 * Supabase client (anon key + session cookies), so RLS and 0073's membership
 * and role checks apply to every call. No service key exists here.
 */
export function workflowDb(supabase: SupabaseClient): WorkflowDb {
  return {
    async rpc(fn, args) {
      const { data, error } = await supabase.rpc(fn, args);
      return { data, error };
    },
    async listWorkflows(orgId) {
      const { data, error } = await supabase
        .from("workflows")
        .select(WORKFLOW_COLUMNS)
        .eq("org_id", orgId)
        .is("archived_at", null)
        .order("updated_at", { ascending: false })
        .limit(100);
      return { data, error };
    },
    async readWorkflow(id) {
      const { data, error } = await supabase.from("workflows").select(WORKFLOW_COLUMNS).eq("id", id).is("archived_at", null).maybeSingle();
      return { data, error };
    },
    async readRun(id) {
      const run = await supabase.from("workflow_runs").select(RUN_COLUMNS).eq("id", id).maybeSingle();
      if (run.error || !run.data) return { data: null, error: run.error };
      const steps = await supabase
        .from("workflow_run_steps")
        .select("step_index,capability,model,status,quoted_credits,charged_credits,job_id,error_code,error")
        .eq("run_id", id)
        .order("step_index", { ascending: true });
      if (steps.error) return { data: null, error: steps.error };
      const rows = (steps.data ?? []) as unknown as Record<string, unknown>[];
      const jobIds = rows.map((s) => s.job_id).filter((j): j is string => typeof j === "string");
      const jobs = new Map<string, { status: unknown; result_asset_ids: unknown }>();
      if (jobIds.length) {
        const j = await supabase.from("creative_jobs").select("id,status,result_asset_ids").in("id", jobIds);
        // A job that cannot be read leaves its step without a live status, never with a made-up one.
        for (const row of (j.data ?? []) as unknown as Record<string, unknown>[]) {
          if (typeof row.id === "string") jobs.set(row.id, { status: row.status, result_asset_ids: row.result_asset_ids });
        }
      }
      return {
        data: {
          run: run.data,
          steps: rows.map((s) => {
            const job = typeof s.job_id === "string" ? jobs.get(s.job_id) : undefined;
            return { ...s, job_status: job?.status ?? null, result_asset_ids: job?.result_asset_ids ?? [] };
          }),
        },
        error: null,
      };
    },
    async listRuns(orgId, workflowId, limit) {
      let q = supabase.from("workflow_runs").select(RUN_COLUMNS).eq("org_id", orgId);
      if (workflowId) q = q.eq("workflow_id", workflowId);
      const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
      return { data, error };
    },
  };
}

/** Signed in, and a client to act as them — or the answer to send instead. */
export async function workflowSession(): Promise<
  { ok: true; db: WorkflowDb; defaultOrg: string | null } | { ok: false; result: CreativeResult }
> {
  const user = await getUser();
  if (!user) return { ok: false, result: { status: 401, body: { error: "unauthorized" } } };
  const supabase = await createClient();
  if (!supabase) return { ok: false, result: { status: 503, body: { error: "not_configured" } } };
  const org = await getOrgContext();
  return { ok: true, db: workflowDb(supabase), defaultOrg: org.current?.id ?? null };
}

export type WorkflowRead<T> =
  | { state: "ok"; value: T }
  | { state: "not_available" }
  | { state: "not_found" }
  | { state: "read_failed" };

/** The organization's workflows, newest edit first. A failed read is its own answer, never "you have none". */
export async function loadWorkflows(orgId: string): Promise<WorkflowRead<Workflow[]>> {
  try {
    const supabase = await createClient();
    if (!supabase || !isUuid(orgId)) return { state: "not_available" };
    const { data, error } = await workflowDb(supabase).listWorkflows(orgId);
    if (error) return isWorkflowMissing(error) ? { state: "not_available" } : { state: "read_failed" };
    return { state: "ok", value: coerceWorkflows(data) };
  } catch {
    return { state: "read_failed" };
  }
}

export async function loadWorkflow(id: string): Promise<WorkflowRead<Workflow>> {
  try {
    const supabase = await createClient();
    if (!supabase) return { state: "not_available" };
    if (!isUuid(id)) return { state: "not_found" };
    const { data, error } = await workflowDb(supabase).readWorkflow(id);
    if (error) return isWorkflowMissing(error) ? { state: "not_available" } : { state: "read_failed" };
    const wf = coerceWorkflow(data);
    // Another organization's workflow and a made-up id read the same: RLS returns no row.
    return wf ? { state: "ok", value: wf } : { state: "not_found" };
  } catch {
    return { state: "read_failed" };
  }
}

export async function loadRun(id: string): Promise<WorkflowRead<RunView>> {
  try {
    const supabase = await createClient();
    if (!supabase) return { state: "not_available" };
    if (!isUuid(id)) return { state: "not_found" };
    const { data, error } = await workflowDb(supabase).readRun(id);
    if (error) return isWorkflowMissing(error) ? { state: "not_available" } : { state: "read_failed" };
    const run = coerceRun(data);
    return run ? { state: "ok", value: run } : { state: "not_found" };
  } catch {
    return { state: "read_failed" };
  }
}

export interface RunSummary {
  id: string;
  workflow_id: string;
  workflow_name: string;
  status: string;
  max_credits: number;
  charged_credits: number;
  created_at: string | null;
}

export async function loadRuns(orgId: string, workflowId: string | null = null, limit = 10): Promise<WorkflowRead<RunSummary[]>> {
  try {
    const supabase = await createClient();
    if (!supabase || !isUuid(orgId)) return { state: "not_available" };
    const { data, error } = await workflowDb(supabase).listRuns(orgId, workflowId, limit);
    if (error) return isWorkflowMissing(error) ? { state: "not_available" } : { state: "read_failed" };
    const rows = Array.isArray(data) ? (data as unknown as Record<string, unknown>[]) : [];
    return {
      state: "ok",
      value: rows.flatMap((r): RunSummary[] =>
        typeof r.id === "string" && typeof r.workflow_id === "string"
          ? [{
              id: r.id,
              workflow_id: r.workflow_id,
              workflow_name: typeof r.workflow_name === "string" ? r.workflow_name : "",
              status: typeof r.status === "string" ? r.status : "running",
              max_credits: Number(r.max_credits) || 0,
              charged_credits: Number(r.charged_credits) || 0,
              created_at: typeof r.created_at === "string" ? r.created_at : null,
            }]
          : [],
      ),
    };
  } catch {
    return { state: "read_failed" };
  }
}
