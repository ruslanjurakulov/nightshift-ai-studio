import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { coercePurchaseRows, historyMissing, type DodoHistoryRead } from "@/lib/dodo-history";

/**
 * The organization's credited Dodo payments (migration 0157), read in the signed-in owner's own session (the anon key: the
 * function itself checks owner/admin). `unsupported` when 0157 is not applied, `failed` for any other error: the page then
 * says which, and never shows an empty history in place of an unread one.
 */
export async function readDodoPurchaseHistory(supabase: SupabaseClient, orgId: string): Promise<DodoHistoryRead> {
  try {
    const { data, error } = await supabase.rpc("dodo_purchase_history", { p_org: orgId });
    if (error) return historyMissing(error) ? { state: "unsupported" } : { state: "failed" };
    return { state: "ok", rows: coercePurchaseRows(data) };
  } catch {
    return { state: "failed" };
  }
}

/**
 * Whether one payment credited this organization (the invoice route asks before it calls Dodo). `missing` when 0157 is not
 * applied; `forbidden` when the database refuses the caller (42501); `unknown` for any other error: none of them is a yes.
 */
export async function dodoPaymentIsOrgs(
  supabase: SupabaseClient,
  orgId: string,
  paymentId: string,
): Promise<"yes" | "no" | "missing" | "forbidden" | "unknown"> {
  try {
    const { data, error } = await supabase.rpc("dodo_purchase_history", { p_org: orgId, p_payment: paymentId });
    if (error) return historyMissing(error) ? "missing" : (error as { code?: string }).code === "42501" ? "forbidden" : "unknown";
    return coercePurchaseRows(data).some((r) => r.paymentId === paymentId) ? "yes" : "no";
  } catch {
    return "unknown";
  }
}
