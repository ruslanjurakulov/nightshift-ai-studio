import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readBillingSummary } from "@/lib/server/plans";
import type { BillingSummary } from "@/lib/plans";
import { nightshiftAiAccess, nightshiftAiWorkspaceOn, type AiPlan, type NightshiftAiAccess } from "@/lib/nightshift-ai-flag";

/** A billing summary as the flag's plan: the operator's exempt workspace is paid; a summary with no plan is not known. */
export function aiPlanOf(summary: BillingSummary | null): AiPlan {
  if (!summary) return "unknown";
  if (summary.exempt) return "paid";
  if (!summary.plan) return "unknown";
  return summary.plan.isDefault ? "free" : "paid";
}

/**
 * Nightshift AI for this workspace, as the signed-in member: the flag first, and the plan (billing_summary, 0034) only when the flag
 * lets the workspace in, so the common case (the flag off) costs no database call. A failed or refused read is "plan_unknown".
 */
export async function readNightshiftAiAccess(orgId: string | null): Promise<NightshiftAiAccess> {
  if (!orgId || !nightshiftAiWorkspaceOn(orgId)) return { open: false, reason: "workspace" };
  const supabase = await createClient();
  if (!supabase) return nightshiftAiAccess(orgId, "unknown");
  const read = await readBillingSummary(supabase, orgId).catch(() => ({ state: "failed" as const }));
  return nightshiftAiAccess(orgId, read.state === "ok" ? aiPlanOf(read.value) : "unknown");
}
