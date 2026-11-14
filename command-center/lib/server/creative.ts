import "server-only";
import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient, getUser } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { JOB_COLUMNS, type CreativeDb, type CreativeResult } from "@/lib/creative/operations";
import { coerceModels, coercePreviewModels, modelLock, onlySellable, withTiers, type StudioModel } from "@/lib/creative/studio";
import { readPurchased } from "@/lib/server/model-discovery";
import { withoutSwitchedOff } from "@/lib/model-switch";
import { readSwitchedOffIds } from "@/lib/server/model-switch";
import { hideBlockedModelsHere } from "@/lib/server/geo";

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
    async listJobs(orgId, limit, capabilities) {
      let query = supabase.from("creative_jobs").select(JOB_COLUMNS).eq("org_id", orgId);
      // A Studio desk asks for its own tools: filtered in the query, so its newest
      // jobs are not crowded out of the page by another desk's.
      if (capabilities && capabilities.length > 0) query = query.in("capability", [...capabilities]);
      const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
      return { data, error };
    },
    async jobDurations(orgId, model, limit) {
      // The model that made a job is its routed model (0075), or the requested one on a row from before routing.
      // `model` is shape-checked by the caller (lowercase letters, digits, dots and dashes), and quoted here besides.
      const { data, error } = await supabase
        .from("creative_jobs")
        .select("started_at,finished_at")
        .eq("org_id", orgId)
        .eq("status", "completed")
        .not("started_at", "is", null)
        .not("finished_at", "is", null)
        .or(`routed_model.eq."${model}",and(routed_model.is.null,requested_model.eq."${model}")`)
        .order("finished_at", { ascending: false })
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
export async function loadStudioModels(orgId: string | null = null): Promise<StudioModel[]> {
  return withLocks((await readStudioModels()) ?? [], orgId);
}

/**
 * Which models this organization cannot buy, by creative_price's own rule (modelLock): the picker then starts on one it can, and
 * names the reason on the others instead of a red refusal. Purchases are read only when a model needs one (`paid`); without an
 * organization (or on a failed read) a `paid` model is not shown locked (unknown is not a refusal), while a plan-tier model is
 * refused for everyone and is shown so. The tool-availability marks read readStudioModels without locks, as before.
 */
async function withLocks(models: StudioModel[], orgId: string | null): Promise<StudioModel[]> {
  if (models.length === 0) return models;
  let purchased: boolean | null = null;
  if (orgId && models.some((m) => m.entitlement === "paid")) {
    try {
      const supabase = await createClient();
      purchased = supabase ? await readPurchased(supabase, orgId) : null;
    } catch {
      purchased = null;
    }
  }
  return models.map((m) => {
    const lock = modelLock(m.entitlement, purchased);
    return lock ? { ...m, lock } : m;
  });
}

/**
 * The same list, with a failed read kept apart from an empty one: null = the
 * registry could not be read (no client, an error), [] = read, nothing on sale.
 * The tool-availability marks (lib/server/tool-availability.ts) need the
 * difference: "could not read" must never be drawn as "not available"
 * (CLAUDE.md rule 5).
 *
 * Memoised per request (React cache): the layout's availability marks and the
 * page's own Studio read the same rows, so one request makes one read.
 */
export const readStudioModels = cache(async (): Promise<StudioModel[] | null> => {
  try {
    const supabase = await createClient();
    if (!supabase) return null;
    const { data, error } = await supabase
      .from("model_registry")
      .select("id,display_name,capabilities,availability,verified_at")
      .in("availability", ["beta", "ga"])
      .not("verified_at", "is", null)
      .order("display_name", { ascending: true })
      .limit(200);
    if (error) return null;
    const models = coerceModels(data);
    if (models.length === 0) return models;
    // The speed and quality marks live in spec, which members cannot read
    // directly; sellable_models() (0035/0046, security definer, granted to
    // signed-in users) returns its public half. Without it the models are
    // simply shown unmarked.
    const marks = await supabase.rpc("sellable_models", { p_capability: null, p_surface: "web" });
    // The owner's switch (migration 0124): the policy already hides a switched-off model from a customer; a platform admin reads every
    // row, so the ids are subtracted here too and the Studio never offers what the quote and the create would refuse.
    const shown = withoutSwitchedOff(models, await readSwitchedOffIds(supabase));
    // sellable_models() also knows what the policy cannot: a vendor's announced shutdown date (migration 0125) ends a sale. When it answered,
    // the picker offers only what it lists; no migration and no policy change, and a failed call leaves the list as it was.
    const offered = marks.error ? shown : withTiers(onlySellable(shown, marks.data), marks.data);
    // A model whose vendor forbids the country this request comes from is not offered (docs/GEO_BLOCK.md); the quote and the
    // create routes refuse it too. Reads nothing while no model has a country list.
    return await hideBlockedModelsHere(offered);
  } catch {
    return null;
  }
});

/**
 * The hidden models the platform operator may try in this organization (migration 0139), marked `preview`. The database decides who
 * sees any: operator_preview_models() answers rows only to a platform admin in the credits-exempt organization, and no rows to
 * everyone else. Without the migration, or on any error: none (never a crash, never a guess).
 */
// Memoised per request (React cache), like readStudioModels: the layout's availability marks and the create page both ask.
export const loadOperatorPreviewModels = cache(async (orgId: string): Promise<StudioModel[]> => {
  try {
    const supabase = await createClient();
    if (!supabase) return [];
    const { data, error } = await supabase.rpc("operator_preview_models", { p_org: orgId });
    if (error) return [];
    // A preview is hidden where its vendor forbids it, like a model on sale (docs/GEO_BLOCK.md); the routes refuse it too.
    return await hideBlockedModelsHere(coercePreviewModels(data));
  } catch {
    return [];
  }
});

/**
 * The models the open organization's members are not offered right now because the owner switched them off (migration 0124): ids only,
 * never a reason. The Studio uses it to say "temporarily unavailable" over a model a form came with (a retried job, a link from the
 * catalog) instead of quietly picking another (CLAUDE.md #4). Without the migration: none.
 */
export async function loadSwitchedOffModels(): Promise<string[]> {
  try {
    const supabase = await createClient();
    return supabase ? await readSwitchedOffIds(supabase) : [];
  } catch {
    return [];
  }
}
