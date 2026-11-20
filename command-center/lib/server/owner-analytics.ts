import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { isSupabaseConfigured } from "@/lib/config";
import { createClient, getUser } from "@/lib/supabase/server";
import { isMissingFunction } from "@/lib/orgs";
import { coerceMoneyRows, type MoneyRow } from "@/lib/owner-analytics/money";
import { coerceFxRates, type FxRate } from "@/lib/owner-analytics/tax";
import {
  coerceBalanceRows,
  coerceCostEntries,
  coerceSpendRows,
  type BalanceRow,
  type CostEntry,
  type SpendRow,
} from "@/lib/owner-analytics/costs";
import { coerceActivityRows, coerceJobRows, coercePeopleRows, type ActivityRow, type JobRow, type PersonRow } from "@/lib/owner-analytics/people";

/**
 * The owner analytics hub's reads (migration 0182), as the signed-in owner, through the ANON key and their own session. No
 * service key: each function refuses everyone but the platform owner itself, which is the protection — hiding the link and
 * this file's own check are only the courtesy in front of it.
 *
 * Every read answers one of five ways, and the page has a sentence for each, so "the database did not answer" never renders
 * as an empty chart or a zero.
 */

export type ReadFailure = "missing" | "forbidden" | "session" | "error";
export type Read<T> = { ok: true; data: T; truncated: boolean } | { ok: false; reason: ReadFailure };

export type Access = "owner" | "denied" | "signed_out" | "missing" | "error" | "not_configured";

/** Is the caller the platform owner? Asked once per request. A failed lookup is "error", never "denied" and never "owner". */
export const ownerAccess = cache(async (): Promise<Access> => {
  if (!isSupabaseConfigured) return "not_configured";
  const user = await getUser();
  if (!user) return "signed_out";
  const supabase = await createClient();
  if (!supabase) return "not_configured";
  try {
    const { data, error } = await supabase.rpc("owner_analytics_is_owner");
    if (error) return isMissingFunction(error) ? "missing" : "error";
    return data === true ? "owner" : "denied";
  } catch {
    return "error";
  }
});

function failure(error: { code?: string; message?: string }): ReadFailure {
  if (isMissingFunction(error)) return "missing";
  if (error.code === "42501") return "forbidden";
  if (error.code === "PGRST301" || error.code === "401" || /jwt/i.test(error.message ?? "")) return "session";
  return "error";
}

/** PostgREST's max-rows on Supabase (1,000 by default; the dashboard can lower it, never raise it past what we ask). */
const PAGE = 1000;
/** Past this the read stops and says so: a page that never finishes is worse than a partial that is labelled one. */
const TIME_BUDGET_MS = 25_000;

/**
 * Every row a function returns, page by page. One request gets at most max-rows rows whatever `.range()` asks, so a single
 * call would hand the page the first 1,000 sales as if they were all of them (CLAUDE.md #5). The functions order their rows
 * deterministically, the next page starts after the rows actually received (a server capping below PAGE cannot make a short
 * page look like the end), and only an empty page ends the read. Hitting the function's own ceiling, or the time budget,
 * comes back `truncated`.
 */
async function rpc<T>(
  fn: string,
  args: Record<string, unknown> | undefined,
  coerce: (d: unknown) => T[],
  limit: number,
): Promise<Read<T[]>> {
  const supabase = await createClient();
  if (!supabase) return { ok: false, reason: "error" };
  const started = Date.now();
  const rows: unknown[] = [];
  try {
    for (;;) {
      const { data, error } = await supabase.rpc(fn, args).range(rows.length, rows.length + PAGE - 1);
      if (error) return { ok: false, reason: failure(error) };
      if (!Array.isArray(data)) return { ok: false, reason: "error" };
      if (data.length === 0) return { ok: true, data: coerce(rows), truncated: false };
      rows.push(...data);
      if (rows.length >= limit || Date.now() - started > TIME_BUDGET_MS) return { ok: true, data: coerce(rows), truncated: true };
    }
  } catch {
    return { ok: false, reason: "error" };
  }
}

export interface InternalOrg {
  orgId: string;
  name: string;
  source: "default" | "flag" | "roster";
  reason: string | null;
  flaggedAt: string | null;
}

/** The workspaces the hub leaves out by default, and why. */
export const readInternalOrgs = cache(async (): Promise<Read<InternalOrg[]>> =>
  rpc(
    "owner_analytics_internal_list",
    undefined,
    (d) =>
      (Array.isArray(d) ? d : []).flatMap((r) => {
        const o = r as Record<string, unknown>;
        const source = o.source === "default" || o.source === "flag" || o.source === "roster" ? o.source : null;
        if (typeof o.org_id !== "string" || !source) return [];
        return [{
          orgId: o.org_id,
          name: typeof o.name === "string" ? o.name : "",
          source,
          reason: typeof o.reason === "string" ? o.reason : null,
          flaggedAt: typeof o.flagged_at === "string" ? o.flagged_at : null,
        }];
      }),
    500,
  ),
);

export const readMoney = cache((from: string, to: string): Promise<Read<MoneyRow[]>> =>
  rpc("owner_analytics_money", { p_from: from, p_to: to }, coerceMoneyRows, 50000),
);
export const readPeople = cache((): Promise<Read<PersonRow[]>> => rpc("owner_analytics_people", undefined, coercePeopleRows, 100000));
export const readActivity = cache((from: string, to: string): Promise<Read<ActivityRow[]>> =>
  rpc("owner_analytics_activity", { p_from: from, p_to: to }, coerceActivityRows, 200000),
);
export const readJobs = cache((from: string, to: string): Promise<Read<JobRow[]>> =>
  rpc("owner_analytics_jobs", { p_from: from, p_to: to }, coerceJobRows, 50000),
);

/** Presentation mode lives in a cookie, so it survives every link and tab of the hub, not only the ones that remember a param. */
export const PRESENT_COOKIE = "ns_oa_present";
export async function presentMode(): Promise<boolean> {
  try {
    return (await cookies()).get(PRESENT_COOKIE)?.value === "1";
  } catch {
    return false;
  }
}

/** Exports need a sign-in this recent. Long enough to export a report, short enough that an unlocked laptop is not a data room. */
export const EXPORT_REAUTH_MINUTES = 15;

/**
 * When the session last proved who it is (password, code, magic link or OAuth), from the token's `amr` claim. Null when it
 * cannot be read — and an export treats null as "too old": a check that cannot be made is not passed.
 */
export async function lastAuthenticatedAt(): Promise<number | null> {
  const supabase = await createClient();
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    let best: number | null = null;
    for (const m of data?.currentAuthenticationMethods ?? []) {
      const ts = Number((m as { timestamp?: unknown }).timestamp);
      if (Number.isFinite(ts) && ts > 0 && (best === null || ts * 1000 > best)) best = ts * 1000;
    }
    return best;
  } catch {
    return null;
  }
}

export function recentEnough(at: number | null, now: number, minutes = EXPORT_REAUTH_MINUTES): boolean {
  return at !== null && now - at <= minutes * 60_000 && at <= now + 60_000;
}

// ── costs (migration 0183) ──────────────────────────────────────────────────

export const readSpend = cache((from: string, to: string): Promise<Read<SpendRow[]>> =>
  rpc("owner_analytics_provider_spend", { p_from: from, p_to: to }, coerceSpendRows, 50000),
);
export const readBalances = cache((): Promise<Read<BalanceRow[]>> => rpc("owner_analytics_balances", undefined, coerceBalanceRows, 500));
export const readCostEntries = cache((fromMonth: string, toMonth: string): Promise<Read<CostEntry[]>> =>
  rpc("owner_analytics_costs", { p_from_month: fromMonth, p_to_month: toMonth }, coerceCostEntries, 5000),
);

// ── frozen exchange rates (migration 0185) ──────────────────────────────────

export const readFxRates = cache((fromDay: string, toDay: string): Promise<Read<FxRate[]>> =>
  rpc("owner_analytics_fx_rates", { p_from: fromDay, p_to: toDay }, coerceFxRates, 5000),
);
