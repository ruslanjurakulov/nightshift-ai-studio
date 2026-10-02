import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";
import type { PlanCatalog } from "@/lib/plans";
import { readPlanCatalog, type PlanRead } from "@/lib/server/plans";
import { cachedPublicRead } from "@/lib/server/public-read";

/**
 * The plan catalog (0034: a public price list) as a SIGNED-OUT page reads it:
 * with the anon key and no session — so one visitor's read is every
 * visitor's — bounded, kept and shared like the price lists
 * (lib/server/public-read.ts; BR-L-101: 30 visitors had made 120 backend
 * calls). A failed or timed-out read is "failed", which the pages say, and is
 * kept only briefly. A signed-in read stays per request (readPlanCatalog).
 */
export async function readPublicPlanCatalog(): Promise<PlanRead<PlanCatalog>> {
  if (!isSupabaseConfigured) return { state: "unsupported" };
  const read = await cachedPublicRead("plan_catalog", async (signal) => {
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const r = await readPlanCatalog(client, { signal });
    return r.state === "failed" ? null : r;
  });
  return read ?? { state: "failed" };
}
