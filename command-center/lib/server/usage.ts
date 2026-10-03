import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isCreditsMissing } from "./credits";
import { coerceUsageSummary, type UsageSummary } from "../usage";
import type { PlanRead } from "./plans";

/**
 * The Usage page's one read: usage_summary() (migration 0094), the caller's
 * own workspace as a single snapshot. Three outcomes that must never blur
 * (CLAUDE.md #5): `ok` (a real summary), `unsupported` (0094 is not applied
 * yet — the page says so and the Credits page keeps working as before) and
 * `failed` (the read errored, or answered something that is not a summary:
 * the figures are UNKNOWN, not 0). `ok` with null is the database's own "you
 * may not read this workspace", which the page treats like a failed read: it
 * has nothing true to show.
 */
export async function readUsageSummary(supabase: SupabaseClient, orgId: string): Promise<PlanRead<UsageSummary>> {
  const { data, error } = await supabase.rpc("usage_summary", { p_org: orgId });
  if (error) return isCreditsMissing(error) ? { state: "unsupported" } : { state: "failed" };
  const summary = coerceUsageSummary(data);
  return summary ? { state: "ok", value: summary } : { state: "failed" };
}
