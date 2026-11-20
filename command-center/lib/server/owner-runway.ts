import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { readAllPages } from "@/lib/paged-read";
import { timed } from "@/lib/server/read-timeout";
import { readFailed } from "@/lib/readState";
import {
  oldestRowMs,
  registryPrices,
  utcDayStart,
  type BalanceRow,
  type BillingSettingsRow,
  type CostRowLite,
  type ProbeRunRow,
  type StudioCostRow,
  type TopupRow,
} from "@/lib/billing";
import { coerceModelActivity, type ModelActivity, type RunwayData } from "@/lib/owner-analytics/runway";

/**
 * The provider runway's reads: the same tables, windows and paging the Billing page uses (app/(app)/[channel]/billing), so
 * the hub's "left" and "spent" can never disagree with Billing's — plus 0183's owner_analytics_model_activity for jobs per
 * model and how the newest one ended. Owner only: the caller has passed ownerAccess(); RLS on the provider tables answers
 * the platform operator, and the 0183 function checks the owner again.
 */

const DAY = 86_400_000;
/** As on the Billing page: back 90 days, or to the first top-up's UTC day, never past 180 days. */
const HORIZON_DAYS = 180;
const notThere = (e: unknown) => (e as { code?: string } | null)?.code === "42P01" || (e as { code?: string } | null)?.code === "42883";

type Rpc = { data: unknown; error: { code?: string } | null };

export const readRunway = cache(async (nowMs: number): Promise<RunwayData | null> => {
  const supabase = await createClient();
  if (!supabase) return null;

  const [b, s, tp] = await Promise.all([
    timed(supabase.from("provider_balances").select("*").order("checked_at", { ascending: false }).limit(200)),
    timed(supabase.from("provider_billing_settings").select("*")),
    timed(supabase.from("provider_topups").select("provider,amount_usd,paid_at").order("paid_at", { ascending: false }).limit(1000)),
  ]);
  const topups = (tp?.data ?? []) as TopupRow[];
  const firstTopup = Math.min(Infinity, ...topups.map((x) => Date.parse(x.paid_at)).filter(Number.isFinite));
  const wantMs = Math.min(nowMs - 90 * DAY, Number.isFinite(firstTopup) ? utcDayStart(firstTopup) : Infinity);
  const sinceMs = Math.max(wantMs, nowMs - HORIZON_DAYS * DAY);
  const sinceIso = new Date(sinceMs).toISOString();
  const nowIso = new Date(nowMs).toISOString();

  type Paged<T> = { data: T[] | null; error: unknown; count: number | null };
  const paged = <T extends { id?: number }>(table: string, cols: string, at: string) =>
    readAllPages<T>(
      (from, to) =>
        timed(
          supabase
            .from(table)
            .select(cols, from === 0 ? { count: "exact" } : undefined)
            .gte(at, sinceIso)
            .order(at, { ascending: false })
            .order("id", { ascending: false })
            .range(from, to),
        ) as unknown as PromiseLike<Paged<T>>,
      { keyOf: (r) => r.id },
    );
  const missingColumn = (e: unknown) => (e as { code?: string } | null)?.code === "42703";
  const probeCols = "id,model_id,ok,error_code,created_at";
  const activity = (fromMs: number) =>
    timed(supabase.rpc("owner_analytics_model_activity", { p_from: new Date(fromMs).toISOString(), p_to: nowIso })) as unknown as Promise<Rpc>;

  const [costs, studio, probes, reg, actAll, act7, act1] = await Promise.all([
    paged<CostRowLite & { id?: number }>("video_costs", "id,unit,quantity,stage,recorded_at", "recorded_at"),
    paged<StudioCostRow & { id?: number }>("creative_job_costs", "id,provider,vendor_model,unit,quantity,usd_estimate,recorded_at", "recorded_at"),
    paged<ProbeRunRow & { id?: number }>("model_probe_runs", `${probeCols},vendor_credits`, "created_at").then((r) =>
      missingColumn(r.error) ? paged<ProbeRunRow & { id?: number }>("model_probe_runs", probeCols, "created_at") : r,
    ),
    timed(supabase.rpc("model_registry_admin")) as unknown as Promise<{ data: unknown[] | null; error: unknown }>,
    activity(sinceMs),
    activity(nowMs - 7 * DAY),
    activity(nowMs - DAY),
  ]);

  const act = (r: Rpc): ModelActivity[] | null => (r.error ? null : coerceModelActivity(r.data));
  return {
    now: nowMs,
    sinceMs,
    // A top-up older than the longest look-back leaves the balance that depends on it unknown (the Billing page says the same).
    horizonCapped: wantMs < sinceMs,
    topups,
    topupsUnread: readFailed(tp) && !notThere(tp?.error),
    balances: (b?.data ?? []) as BalanceRow[],
    balancesUnread: readFailed(b) && !notThere(b?.error),
    settings: readFailed(s) ? null : ((s?.data ?? []) as BillingSettingsRow[]),
    pipelineRows: costs.rows,
    pipelineUnread: Boolean(costs.error),
    pipelineFromMs: costs.truncated ? (oldestRowMs(costs.rows) ?? nowMs) : sinceMs,
    studioRows: studio.rows,
    studioUnread: Boolean(studio.error),
    studioFromMs: studio.truncated ? (oldestRowMs(studio.rows) ?? nowMs) : sinceMs,
    probeRows: probes.rows,
    probesUnread: Boolean(probes.error),
    probesFromMs: probes.truncated ? (oldestRowMs(probes.rows.map((x) => ({ recorded_at: x.created_at }))) ?? nowMs) : sinceMs,
    registry: readFailed(reg) || !Array.isArray(reg?.data) ? null : registryPrices(reg.data),
    activity: { all: act(actAll), d7: act(act7), d1: act(act1), missing: notThere(actAll.error) },
  };
});
