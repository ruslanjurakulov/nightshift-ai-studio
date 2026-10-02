import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingFunction } from "@/lib/orgs";
import { readCreditPrices } from "@/lib/server/credits";
import { coerceSellableModels } from "@/lib/creative/registry";
import { coerceAdminModels, latestProbes } from "@/lib/models-admin";
import {
  fromAdminRow,
  fromSellableRow,
  publicSpecOf,
  showsProvider,
  type DiscoveryModel,
  type PriceList,
  type Reason,
} from "@/lib/models-discovery";

/**
 * The Models screen's reads, as the signed-in person (their own session: RLS
 * and the security-definer functions' own checks apply). No service key.
 *
 *  - customer: sellable_models('web') — what the database would sell them —
 *    and the price list (0020: readable by any signed-in user);
 *  - operator: model_registry_admin() (refused to anyone but a platform admin
 *    with 42501), the probe log and the price list.
 *
 * What leaves for the browser is DiscoveryModel only: the public half of each
 * spec (publicSpecOf — never provider costs, vendor ids or notes) and each
 * model's rates as read from the price list (never the list itself, with its
 * margins and notes).
 */

export type DiscoveryRead =
  | { status: "ok"; models: DiscoveryModel[]; pricesRead: boolean; probesRead: boolean }
  | { status: "not_enabled" | "forbidden" | "error" };

/** The price list as unit -> rate, or null when it could not be read (never an empty list that reads as "free"). */
export async function readPriceList(supabase: SupabaseClient): Promise<PriceList> {
  try {
    const read = await readCreditPrices(supabase);
    if (!read.supported || read.failed) return null;
    return Object.fromEntries(Object.values(read.prices).map((p) => [p.unit, p.creditsPerUnit]));
  } catch {
    return null;
  }
}

/**
 * Has the organization made a credit purchase (or is it exempt)? The same two
 * facts create_creative_job checks for a `paid` model (0050/0072), read as the
 * member: credits_exempt() is granted to signed-in users and
 * credit_transactions is readable by the organization's members (0020).
 * null = not known (no organization, or a read failed): the screen then words
 * the gate conditionally rather than guess.
 */
export async function readPurchased(supabase: SupabaseClient, orgId: string | null): Promise<boolean | null> {
  if (!orgId) return null;
  try {
    const exempt = await supabase.rpc("credits_exempt", { p_org: orgId });
    if (!exempt.error && exempt.data === true) return true;
    const { data, error } = await supabase
      .from("credit_transactions")
      .select("id")
      .eq("org_id", orgId)
      .eq("kind", "purchase")
      .limit(1);
    if (error || !Array.isArray(data)) return null;
    return data.length > 0;
  } catch {
    return null;
  }
}

/** What a customer's browser receives: no provider (unless the owner turns it on), no raw entitlement key. */
export function customerShape(m: DiscoveryModel): DiscoveryModel {
  return {
    ...m,
    provider: showsProvider(false) ? m.provider : "",
    entitlement: null,
    reasons: m.reasons.map((r): Reason => (r.kind === "not_open" ? { kind: "not_open", key: "", value: null } : r)),
  };
}

export async function readCustomerModels(supabase: SupabaseClient, orgId: string | null = null): Promise<DiscoveryRead> {
  try {
    const [sellable, prices] = await Promise.all([
      supabase.rpc("sellable_models", { p_capability: null, p_surface: "web" }),
      readPriceList(supabase),
    ]);
    if (sellable.error) {
      if (isMissingFunction(sellable.error)) return { status: "not_enabled" };
      if (sellable.error.code === "42501") return { status: "forbidden" };
      return { status: "error" };
    }
    // coerceSellableModels is the gate (beta/ga, verified, a positive base
    // price, a valid spec): a row it drops is not shown, whatever the SQL says.
    const allowed = new Set(coerceSellableModels(sellable.data).map((m) => m.id));
    const rows = Array.isArray(sellable.data) ? sellable.data : [];
    // Only asked when a model needs it: most deployments sell none behind `paid`.
    const needsPurchase = rows.some((r) => !!r && typeof r === "object" && (r as Record<string, unknown>).entitlement === "paid");
    const purchased = needsPurchase ? await readPurchased(supabase, orgId) : null;
    const models = rows
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && allowed.has(String((r as Record<string, unknown>).id)))
      .map((r) => fromSellableRow(r, prices, purchased))
      .filter((m): m is DiscoveryModel => m !== null)
      // A customer is not shown who makes a model, so the name does not travel to their browser either;
      // nor does the raw plan key (the state it decided is kept).
      .map(customerShape);
    return { status: "ok", models, pricesRead: prices !== null, probesRead: false };
  } catch {
    return { status: "error" };
  }
}

export async function readOperatorModels(supabase: SupabaseClient): Promise<DiscoveryRead> {
  try {
    const [registry, probes, prices] = await Promise.all([
      supabase.rpc("model_registry_admin"),
      supabase
        .from("model_probe_runs")
        .select("model_id,ok,error_code,capability,created_at")
        .order("created_at", { ascending: false })
        .limit(2000),
      readPriceList(supabase),
    ]);
    if (registry.error) {
      if (isMissingFunction(registry.error)) return { status: "not_enabled" };
      if (registry.error.code === "42501") return { status: "forbidden" };
      return { status: "error" };
    }
    const rows = Array.isArray(registry.data) ? (registry.data as unknown[]) : [];
    const specs = new Map<string, unknown>();
    for (const r of rows) if (r && typeof r === "object") specs.set(String((r as Record<string, unknown>).id), (r as Record<string, unknown>).spec);
    const latest = probes.error ? null : latestProbes(probes.data);
    const models = coerceAdminModels(rows).map((m) =>
      fromAdminRow(
        {
          id: m.id,
          displayName: m.displayName,
          provider: m.provider,
          capabilities: m.capabilities,
          availability: m.availability,
          verifiedAt: m.verifiedAt,
          creditUnit: m.creditUnit,
          entitlement: m.entitlement,
          termsGate: m.termsGate,
          removedFromFile: m.removedFromFile,
          publicSpec: publicSpecOf(specs.get(m.id)),
        },
        latest?.[m.id] ?? null,
        prices,
      ),
    );
    return { status: "ok", models, pricesRead: prices !== null, probesRead: latest !== null };
  } catch {
    return { status: "error" };
  }
}
