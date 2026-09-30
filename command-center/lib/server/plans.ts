import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  coerceBillingSummary,
  coerceLots,
  coercePlanCatalog,
  sortLots,
  type BillingSummary,
  type CreditLot,
  type PlanCatalog,
} from "../plans";

/**
 * Plans (migration 0034), read with whatever client the page has: the catalog
 * is a public price list (anon may read it, so the signed-out /pricing page
 * shows it), the billing summary and lots are the organization's own (RLS /
 * billing_summary's membership check). No service key, no writes.
 */

/** The plan catalog, or null when 0034 is not applied or the read failed. */
export async function readPlanCatalog(supabase: SupabaseClient): Promise<PlanCatalog | null> {
  const [plans, keys, values, policies] = await Promise.all([
    supabase.from("plans").select("id,name,sort_order,monthly_credits,is_default,is_public").order("sort_order"),
    supabase.from("entitlement_keys").select("key,value_type,default_value,exempt_value,status,sort_order").order("sort_order"),
    supabase.from("plan_entitlements").select("plan_id,key,value"),
    supabase.from("credit_lot_policies").select("source,valid_months"),
  ]);
  if (plans.error || keys.error || values.error) return null;
  return coercePlanCatalog(plans.data, keys.data, values.data, policies.error ? undefined : policies.data);
}

/** This organization's plan, subscription and credits by source; null when unreadable. */
export async function readBillingSummary(supabase: SupabaseClient, orgId: string): Promise<BillingSummary | null> {
  const { data, error } = await supabase.rpc("billing_summary", { p_org: orgId });
  if (error) return null;
  return coerceBillingSummary(data);
}

/** The organization's lots, live ones first, then the most recent history. */
export async function readCreditLots(supabase: SupabaseClient, orgId: string, limit = 50): Promise<CreditLot[] | null> {
  const { data, error } = await supabase
    .from("credit_lots")
    .select("id,source,amount,remaining,held,expires_at,created_at,note")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return null;
  return sortLots(coerceLots(data));
}
