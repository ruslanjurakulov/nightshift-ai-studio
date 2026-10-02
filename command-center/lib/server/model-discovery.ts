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
  type DiscoveryModel,
  type PriceList,
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

export async function readCustomerModels(supabase: SupabaseClient): Promise<DiscoveryRead> {
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
    const models = rows
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && allowed.has(String((r as Record<string, unknown>).id)))
      .map((r) => fromSellableRow(r, prices))
      .filter((m): m is DiscoveryModel => m !== null);
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
