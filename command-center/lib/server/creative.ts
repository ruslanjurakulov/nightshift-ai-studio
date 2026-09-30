import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient, getUser } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { JOB_COLUMNS, type CreativeDb, type CreativeResult } from "@/lib/creative/operations";

/**
 * The creative operations' database door for the web: the signed-in user's
 * own Supabase client (anon key + session cookies), so RLS and 0036's
 * membership checks apply to every call. No service key exists here.
 */
export function creativeDb(supabase: SupabaseClient): CreativeDb {
  return {
    async rpc(fn, args) {
      const { data, error } = await supabase.rpc(fn, args);
      return { data, error };
    },
    async readJob(id) {
      const { data, error } = await supabase.from("creative_jobs").select(JOB_COLUMNS).eq("id", id).maybeSingle();
      return { data, error };
    },
    async listJobs(orgId, limit) {
      const { data, error } = await supabase
        .from("creative_jobs")
        .select(JOB_COLUMNS)
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .limit(limit);
      return { data, error };
    },
  };
}

/** Signed in, and a client to act as them — or the answer to send instead. */
export async function creativeSession(): Promise<
  { ok: true; db: CreativeDb; defaultOrg: string | null } | { ok: false; result: CreativeResult }
> {
  const user = await getUser();
  if (!user) return { ok: false, result: { status: 401, body: { error: "unauthorized" } } };
  const supabase = await createClient();
  if (!supabase) return { ok: false, result: { status: 503, body: { error: "not_configured" } } };
  const org = await getOrgContext();
  return { ok: true, db: creativeDb(supabase), defaultOrg: org.current?.id ?? null };
}
