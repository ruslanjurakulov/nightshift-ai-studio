import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  coerceOwnerSecurity,
  coercePriceHistory,
  coerceProviderSpend,
  coerceSecurityEvents,
  type OwnerSecurity,
  type PriceHistoryEntry,
  type SecurityEvent,
  type SpendRow,
} from "@/lib/owner-reads";
import { granted24h, reversedGrantIds, reversibleGrants, type GrantRow, type ReversibleGrant } from "@/lib/owner-rpc";

/**
 * The reads behind the owner pages while NIGHTSHIFT_OWNER_RPC is on. All of them run as the signed-in user (the
 * functions check platform owner/admin themselves; the tables answer a platform admin only) and none of them is
 * called while the flag is off.
 *
 * Each answers `ok`, `unsupported` (migration 0106/0107 not applied: the page shows what it showed before) or
 * `failed` (unknown: never an empty list or a zero in its place).
 */
export type OwnerRead<T> = { state: "ok"; value: T } | { state: "unsupported" } | { state: "failed" };

type PgError = { code?: string | null; message?: string | null } | null;

/** 42883 / PGRST202: the function is not there. 42P01 / PGRST205: the table is not there. */
function missing(error: PgError): boolean {
  return ["42883", "PGRST202", "42P01", "PGRST205"].includes(error?.code ?? "");
}

async function rpc<T>(supabase: SupabaseClient, fn: string, args: Record<string, unknown>, coerce: (data: unknown) => T | null): Promise<OwnerRead<T>> {
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) return missing(error) ? { state: "unsupported" } : { state: "failed" };
    const value = coerce(data);
    return value === null ? { state: "failed" } : { state: "ok", value };
  } catch {
    return { state: "failed" };
  }
}

/** owner_security_get(): the gate state, the caps, the admins and their verified-factor counts. */
export function readOwnerSecurity(supabase: SupabaseClient): Promise<OwnerRead<OwnerSecurity>> {
  return rpc(supabase, "owner_security_get", {}, coerceOwnerSecurity);
}

/** owner_security_events(limit): the newest security events, newest first. */
export function readOwnerSecurityEvents(supabase: SupabaseClient, limit = 30): Promise<OwnerRead<SecurityEvent[]>> {
  return rpc(supabase, "owner_security_events", { p_limit: limit }, coerceSecurityEvents);
}

/** owner_provider_spend(days): what each provider billed per UTC day, as at most days x providers rows. */
export function readOwnerProviderSpend(supabase: SupabaseClient, days = 30): Promise<OwnerRead<SpendRow[]>> {
  return rpc(supabase, "owner_provider_spend", { p_days: days }, coerceProviderSpend);
}

/** The newest price changes with their old and new figures (credit_price_history; a platform admin reads it directly). */
export async function readPriceHistory(supabase: SupabaseClient, limit = 40): Promise<OwnerRead<PriceHistoryEntry[]>> {
  try {
    const { data, error } = await supabase
      .from("credit_price_history")
      .select("id,at,unit,action,old_credits_per_unit,old_margin,new_credits_per_unit,new_margin,reason,source")
      .order("id", { ascending: false })
      .limit(limit);
    if (error) return missing(error) ? { state: "unsupported" } : { state: "failed" };
    const value = coercePriceHistory(data);
    return value === null ? { state: "failed" } : { state: "ok", value };
  } catch {
    return { state: "failed" };
  }
}

export interface GrantWindow {
  /** Grants of this organization inside the reversal window, newest first. */
  grants: ReversibleGrant[];
  /** Credits granted through the owner path in the last 24 hours, all organizations (what the 24 h cap counts); null when unreadable. */
  granted24h: number | null;
}

const GRANT_COLS = "id,org_id,kind,amount,created_at,note,external_id,created_by";

/**
 * The grants that can still be reversed here, and how much of the 24 hour cap is used. Two small reads: this
 * organization's grants and reversals inside the window, and the last 24 hours of grants across organizations
 * (the cap counts every actor together).
 */
export async function readGrantWindow(supabase: SupabaseClient, orgId: string, windowDays: number, nowMs = Date.now()): Promise<OwnerRead<GrantWindow>> {
  try {
    const since = new Date(nowMs - windowDays * 86_400_000).toISOString();
    const since24 = new Date(nowMs - 86_400_000).toISOString();
    const [mine, adjusts, day] = await Promise.all([
      supabase.from("credit_transactions").select(GRANT_COLS).eq("org_id", orgId).eq("kind", "grant").gte("created_at", since).order("id", { ascending: false }).limit(100),
      supabase.from("credit_transactions").select("id,external_id").eq("org_id", orgId).eq("kind", "adjust").like("external_id", "owner-reverse:%").gte("created_at", since).limit(500),
      supabase.from("credit_transactions").select(GRANT_COLS).eq("kind", "grant").gte("created_at", since24).limit(1000),
    ]);
    if (mine.error || adjusts.error) return { state: "failed" };
    const rows = (mine.data ?? []) as unknown as GrantRow[];
    const reversed = reversedGrantIds((adjusts.data ?? []) as { external_id: string | null }[]);
    return {
      state: "ok",
      value: {
        grants: reversibleGrants(rows, reversed, windowDays, nowMs),
        // A read that hit its ceiling counted only part of the day: unknown, not a smaller figure.
        granted24h: day.error || (day.data ?? []).length >= 1000 ? null : granted24h((day.data ?? []) as unknown as GrantRow[], nowMs),
      },
    };
  } catch {
    return { state: "failed" };
  }
}
