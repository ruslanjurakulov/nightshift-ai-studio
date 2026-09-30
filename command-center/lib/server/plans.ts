import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isCreditsMissing } from "./credits";
import {
  billingCreditsReadable,
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

/**
 * Every plan read ends one of three ways, and they must never blur (CLAUDE.md
 * #5): `ok` (a real answer, possibly "nothing for this user"), `unsupported`
 * (0034 is not applied on this deployment — the page shows what it showed
 * before), or `failed` (the read itself errored or came back malformed — the
 * value is UNKNOWN: no plan name, no "Free", no zero credits, no empty list).
 */
export type PlanRead<T> = { state: "ok"; value: T } | { state: "unsupported" } | { state: "failed" };

/** The value of a read that succeeded, else null (for callers with no unknown state to show). */
export function planValue<T>(r: PlanRead<T>): T | null {
  return r.state === "ok" ? r.value : null;
}

type ReadError = { code?: string; message?: string } | null | undefined;

function classify(errors: ReadError[]): "unsupported" | "failed" | null {
  const real = errors.filter((e): e is NonNullable<ReadError> => Boolean(e));
  if (real.length === 0) return null;
  return real.some((e) => isCreditsMissing(e)) ? "unsupported" : "failed";
}

/** The plan catalog (public price list). */
export async function readPlanCatalog(supabase: SupabaseClient): Promise<PlanRead<PlanCatalog>> {
  const [plans, keys, values, policies] = await Promise.all([
    supabase.from("plans").select("id,name,sort_order,monthly_credits,is_default,is_public").order("sort_order"),
    supabase.from("entitlement_keys").select("key,value_type,default_value,exempt_value,status,sort_order").order("sort_order"),
    supabase.from("plan_entitlements").select("plan_id,key,value"),
    supabase.from("credit_lot_policies").select("source,valid_months"),
  ]);
  const bad = classify([plans.error, keys.error, values.error]);
  if (bad) return { state: bad };
  // The pack validity is optional: without it the page falls back to the env.
  const catalog = coercePlanCatalog(plans.data, keys.data, values.data, policies.error ? undefined : policies.data);
  return catalog ? { state: "ok", value: catalog } : { state: "failed" };
}

/**
 * This organization's plan, subscription and credits by source. `ok` with a
 * null value is billing_summary's own "you may not read this organization"
 * (it returns null then), which is not a failure. A summary whose credit
 * figures are not all numbers is a failed read: coerceBillingSummary would
 * turn them into 0.
 */
export async function readBillingSummary(
  supabase: SupabaseClient,
  orgId: string,
): Promise<PlanRead<BillingSummary | null>> {
  const { data, error } = await supabase.rpc("billing_summary", { p_org: orgId });
  const bad = classify([error]);
  if (bad) return { state: bad };
  if (data == null) return { state: "ok", value: null };
  if (!billingCreditsReadable(data)) return { state: "failed" };
  const summary = coerceBillingSummary(data);
  return summary ? { state: "ok", value: summary } : { state: "failed" };
}

/** The organization's lots, live ones first, then the most recent history. */
export async function readCreditLots(supabase: SupabaseClient, orgId: string, limit = 50): Promise<PlanRead<CreditLot[]>> {
  const { data, error } = await supabase
    .from("credit_lots")
    .select("id,source,amount,remaining,held,expires_at,created_at,note")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(limit);
  const bad = classify([error]);
  if (bad) return { state: bad };
  if (!Array.isArray(data)) return { state: "failed" };
  const lots = coerceLots(data);
  // A row that cannot be read is dropped by coerceLots; a list with holes
  // would understate what the organization has.
  if (lots.length !== data.length) return { state: "failed" };
  return { state: "ok", value: sortLots(lots) };
}
