import "server-only";
import { createClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { isMissingFunction } from "@/lib/orgs";
import {
  SOCIAL_ACCOUNT_COLUMNS,
  SOCIAL_ACCOUNT_COLUMNS_0028,
  coerceSocialAccounts,
  socialStoreErrorResult,
  toConnectedAccounts,
  type ConnectedSocialAccount,
  type SocialAccount,
  type SocialPlatform,
  type SocialResult,
} from "@/lib/social-accounts";
import type { SocialProfile } from "@/lib/server/social-oauth";
import type { InstagramConnection } from "@/lib/server/connect-pending";

/**
 * Instagram / TikTok connections (migration 0028) — the server half.
 *
 * Everything runs as the SIGNED-IN USER (anon key + their session cookie). The
 * app never holds the service key: store_social_account is write-only and
 * checks the org role itself, and social_accounts has no token column, so
 * reading it through RLS returns nothing secret.
 */

/** Seal the tokens into Vault through store_social_account. Result word only. */
export async function storeSocialAccount(opts: {
  orgId: string;
  platform: SocialPlatform;
  accessToken: string;
  refreshToken: string | null;
  profile: SocialProfile;
  scopes: string[];
  accessExpiresIn: number | null;
  refreshExpiresIn: number | null;
  /** Instagram only: the Unified Login connection's portfolio and configuration (0197 refuses an Instagram
   *  connect without them). */
  instagram?: InstagramConnection;
}): Promise<{ result: SocialResult; accountId: string | null }> {
  const supabase = await createClient();
  if (!supabase) return { result: "not_available", accountId: null };
  try {
    const meta: Record<string, unknown> = {
      external_id: opts.profile.externalId,
      username: opts.profile.username,
      display_name: opts.profile.displayName,
      avatar_url: opts.profile.avatarUrl,
      scopes: opts.scopes,
    };
    if (opts.accessExpiresIn != null) meta.access_expires_in = opts.accessExpiresIn;
    if (opts.refreshExpiresIn != null) meta.refresh_expires_in = opts.refreshExpiresIn;
    if (opts.platform === "instagram" && opts.instagram) {
      meta.auth_flow = "unified_login";
      meta.config_id = opts.instagram.configId;
      if (opts.instagram.clientBusinessId) meta.client_business_id = opts.instagram.clientBusinessId;
    }
    const { data, error } = await supabase.rpc("store_social_account", {
      p_org_id: opts.orgId,
      p_platform: opts.platform,
      p_access_token: opts.accessToken,
      p_refresh_token: opts.refreshToken,
      p_meta: meta,
    });
    if (error) return { result: socialStoreErrorResult(error), accountId: null };
    const id = data && typeof data === "object" && typeof (data as { id?: unknown }).id === "string"
      ? (data as { id: string }).id
      : null;
    return { result: "connected", accountId: id };
  } catch {
    return { result: "failed", accountId: null };
  }
}

export async function revokeSocialAccount(
  accountId: string,
): Promise<{ ok: true; revoked: boolean } | { ok: false; error: "not_available" | "forbidden" | "failed" }> {
  const supabase = await createClient();
  if (!supabase) return { ok: false, error: "not_available" };
  try {
    const { data, error } = await supabase.rpc("revoke_social_account", { p_account_id: accountId });
    if (error) {
      if (isMissingFunction(error)) return { ok: false, error: "not_available" };
      return { ok: false, error: error.code === "42501" ? "forbidden" : "failed" };
    }
    return { ok: true, revoked: data === true };
  } catch {
    return { ok: false, error: "failed" };
  }
}

/** 42703 (undefined column) / PGRST204: 0197's auth_flow is not there yet. */
function missingColumn(error: { code?: string | null } | null): boolean {
  return Boolean(error && (error.code === "42703" || error.code === "PGRST204"));
}

type Read = { data: unknown; error: { code?: string | null } | null };

/**
 * Read social_accounts with 0197's column, or, on a database that has not applied 0197, without it. The
 * fallback is honest rather than generous: with no auth_flow every Instagram row is an old Instagram Login
 * connection (coerceSocialAccounts reads the missing field as null), so it shows as "reconnect needed" instead of
 * hiding every account, TikTok's included, behind "not set up".
 */
async function selectAccounts(run: (columns: string) => PromiseLike<Read>): Promise<Read> {
  const first = await run(SOCIAL_ACCOUNT_COLUMNS);
  if (!missingColumn(first.error)) return first;
  return run(SOCIAL_ACCOUNT_COLUMNS_0028);
}

/** One account row by id, if the caller can see it (RLS). */
export async function fetchSocialAccount(accountId: string): Promise<SocialAccount | null> {
  const supabase = await createClient();
  if (!supabase) return null;
  try {
    const { data } = await selectAccounts((cols) => supabase.from("social_accounts").select(cols).eq("id", accountId).limit(1));
    return coerceSocialAccounts(data)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The organization's accounts (all statuses but revoked). `available` is false
 * when 0028 is not applied or the lookup failed — the page then says so
 * instead of offering a Connect button that cannot work.
 */
export async function fetchSocialAccounts(orgId: string | null): Promise<{ available: boolean; rows: SocialAccount[] }> {
  if (!orgId) return { available: false, rows: [] };
  const supabase = await createClient();
  if (!supabase) return { available: false, rows: [] };
  try {
    const { data, error } = await selectAccounts((cols) =>
      supabase
        .from("social_accounts")
        .select(cols)
        .eq("org_id", orgId)
        .neq("status", "revoked")
        .order("platform")
        .order("connected_at", { ascending: true }),
    );
    if (error) return { available: false, rows: [] };
    return { available: true, rows: coerceSocialAccounts(data) };
  } catch {
    return { available: false, rows: [] };
  }
}

/**
 * Instagram / TikTok accounts of the organization being viewed, in the header
 * list's shape. lib/connectedAccounts.ts (YouTube channels) merges these:
 *   return [...youtube, ...(await listConnectedSocialAccounts())];
 */
export async function listConnectedSocialAccounts(): Promise<ConnectedSocialAccount[]> {
  const org = await getOrgContext();
  if (!org.supported || !org.current) return [];
  const { rows } = await fetchSocialAccounts(org.current.id);
  return toConnectedAccounts(rows);
}
