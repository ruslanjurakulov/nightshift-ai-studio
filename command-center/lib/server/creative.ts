import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient, getUser } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { JOB_COLUMNS, type CreativeDb, type CreativeResult } from "@/lib/creative/operations";
import { coerceModels, withTiers, type StudioModel } from "@/lib/creative/studio";

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

/**
 * The models the signed-in member may pick in the Studio (migration 0035),
 * read with their own client: RLS shows sellable rows' public columns only.
 * The filter is repeated here because a platform admin's RLS shows every row,
 * and the Studio offers only what quote/create would accept. A missing table
 * or a failed read is "nothing to pick", never a crash.
 */
export async function loadStudioModels(): Promise<StudioModel[]> {
  try {
    const supabase = await createClient();
    if (!supabase) return [];
    const { data, error } = await supabase
      .from("model_registry")
      .select("id,display_name,capabilities,availability,verified_at")
      .in("availability", ["beta", "ga"])
      .not("verified_at", "is", null)
      .order("display_name", { ascending: true })
      .limit(200);
    if (error) return [];
    const models = coerceModels(data);
    if (models.length === 0) return models;
    // The speed and quality marks live in spec, which members cannot read
    // directly; sellable_models() (0035/0046, security definer, granted to
    // signed-in users) returns its public half. Without it the models are
    // simply shown unmarked.
    const marks = await supabase.rpc("sellable_models", { p_capability: null, p_surface: "web" });
    return marks.error ? models : withTiers(models, marks.data);
  } catch {
    return [];
  }
}
