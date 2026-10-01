import "server-only";
import { createClient } from "@/lib/supabase/server";
import { isCreditExempt } from "@/lib/credits";
import { paddleClient } from "@/lib/paddle";
import { PLAN_ENV } from "@/lib/plans";
import { readBillingSummary, readPlanCatalog } from "@/lib/server/plans";
import { upsellCatalog, type UpsellCatalog } from "@/lib/upsell";

/**
 * What the Studio's plan dialog may offer this organization: the same plan
 * catalog and billing summary reads the Credits page makes (0034, as the
 * signed-in user — RLS and billing_summary's membership check apply). Read
 * only; nothing here opens a checkout or loads the payment provider.
 *
 * null: an organization that never pays (no dialog at all). A read that
 * failed comes back as a catalog with `plans: null`, which the dialog shows
 * as "could not be read" — never as "no plans".
 */
export async function loadUpsellCatalog(orgId: string): Promise<UpsellCatalog | null> {
  if (isCreditExempt(orgId)) return null;
  try {
    const supabase = await createClient();
    if (!supabase) return upsellCatalog(null, "failed", null, PLAN_ENV, null, false);
    const [catalogRead, summaryRead] = await Promise.all([
      readPlanCatalog(supabase).catch(() => ({ state: "failed" as const })),
      readBillingSummary(supabase, orgId).catch(() => ({ state: "failed" as const })),
    ]);
    const catalog = catalogRead.state === "ok" ? catalogRead.value : null;
    const summary = summaryRead.state === "ok" ? summaryRead.value : null;
    return upsellCatalog(catalog, catalogRead.state, summary, PLAN_ENV, paddleClient, false);
  } catch {
    return upsellCatalog(null, "failed", null, PLAN_ENV, null, false);
  }
}
