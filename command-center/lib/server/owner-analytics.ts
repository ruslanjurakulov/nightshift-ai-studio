import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { isSupabaseConfigured } from "@/lib/config";
import { createClient, getUser } from "@/lib/supabase/server";
import { isMissingFunction } from "@/lib/orgs";
import { coerceMoneyRows, type MoneyRow } from "@/lib/owner-analytics/money";
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

async function rpc<T>(
  fn: string,
  args: Record<string, unknown> | undefined,
  coerce: (d: unknown) => T[],
  limit: number,
): Promise<Read<T[]>> {
  const supabase = await createClient();
  if (!supabase) return { ok: false, reason: "error" };
  try {
    // PostgREST caps a response at its max-rows; ask for the function's own ceiling so a cut is visible as `truncated`.
    const { data, error } = await supabase.rpc(fn, args).range(0, limit - 1);
    if (error) return { ok: false, reason: failure(error) };
    if (!Array.isArray(data)) return { ok: false, reason: "error" };
    return { ok: true, data: coerce(data), truncated: data.length >= limit };
  } catch {
    return { ok: false, reason: "error" };
  }
}

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
