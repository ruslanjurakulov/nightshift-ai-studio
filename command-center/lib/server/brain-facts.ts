import "server-only";
import { createClient } from "@/lib/supabase/server";
import { coerceFacts, type BrainFactsRead } from "@/lib/brain/dashboard";

export type { BrainFactsRead };

/**
 * brain_org_facts (migration 0202) for one organization, read as the signed-in
 * person: the database answers only for an org they are a member of (anyone
 * else gets null, read here as not_found). Four outcomes that never blur:
 * the facts; "not available" (0202 not applied: the page says so); "could not
 * read" (a retry, no figure); and not found.
 */


/** The function, or a table it reads (0047/0133 on an older database), is not there: "not switched on", never a retry loop. */
function isMissingFunction(e: { code?: string; message?: string } | null): boolean {
  return Boolean(
    e && (e.code === "PGRST202" || e.code === "42883" || e.code === "42P01" || /could not find the function/i.test(e.message ?? "")),
  );
}

export async function readBrainFacts(orgId: string): Promise<BrainFactsRead> {
  const supabase = await createClient();
  if (!supabase) return { state: "not_available" };
  try {
    const { data, error } = await supabase.rpc("brain_org_facts", { p_org: orgId });
    if (error) return isMissingFunction(error) ? { state: "not_available" } : { state: "failed" };
    if (data === null || data === undefined) return { state: "not_found" };
    const facts = coerceFacts(data);
    // An answer about another org than the one asked for is not an answer.
    if (!facts || facts.orgId !== orgId) return { state: "failed" };
    return { state: "ok", facts };
  } catch {
    return { state: "failed" };
  }
}
