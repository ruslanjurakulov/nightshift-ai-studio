import "server-only";
import { createClient } from "@/lib/supabase/server";
import { isMissingFunction } from "@/lib/orgs";
import {
  coerceTokenStatuses,
  decideTokenStore,
  requestedScopesOnly,
  storeErrorResult,
  type ChannelTokenStatus,
  type TokenStore,
  type VaultResult,
} from "@/lib/channel-tokens";
import { GOOGLE_CLIENT_ID, YOUTUBE_OAUTH_SCOPES } from "@/lib/server/google-oauth";

/**
 * Customer channels' YouTube connection (migration 0022) — the server half.
 *
 * Everything here runs as the SIGNED-IN USER (the anon key plus their session
 * cookie). This app never holds the service key, and it does not need to:
 * store_channel_token is write-only and checks the org role itself, and
 * channel_token_status returns nothing secret. The refresh token passes
 * through exactly one place — storeVaultToken's RPC argument — and is never
 * logged, returned, or put in an error.
 */

/** Which store a channel's token belongs in (lib/channel-tokens.ts decides). */
export async function resolveTokenStore(ref: string): Promise<TokenStore> {
  const channelId = (ref || "").trim();
  if (!channelId) return { mode: "github" };
  const supabase = await createClient();
  if (!supabase) return { mode: "github" };
  try {
    const { data, error } = await supabase.rpc("channel_org", { ch: channelId });
    if (error) return decideTokenStore({ orgId: null, missingFunction: isMissingFunction(error), failed: true });
    return decideTokenStore({ orgId: typeof data === "string" ? data : null });
  } catch {
    return { mode: "unavailable" };
  }
}

/** The YouTube channel the just-granted token acts for, from channels.list
 *  (mine=true, 1 quota unit, youtube.readonly — already requested). */
export async function fetchGrantedChannel(accessToken: string): Promise<{ id: string; title: string } | null> {
  try {
    const res = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=1", {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: { id?: unknown; snippet?: { title?: unknown } }[] };
    const item = body.items?.[0];
    if (!item || typeof item.id !== "string" || !item.id) return null;
    const title = typeof item.snippet?.title === "string" ? item.snippet.title.slice(0, 200) : "";
    return { id: item.id, title };
  } catch {
    return null;
  }
}

/**
 * Seal a refresh token into Vault through store_channel_token, as the signed-in
 * user. Returns a result word only.
 */
export async function storeVaultToken(opts: {
  channelId: string;
  refreshToken: string;
  grantedScopes: string[];
  youtube: { id: string; title: string };
}): Promise<VaultResult> {
  const supabase = await createClient();
  if (!supabase) return "not_available";
  try {
    const { error } = await supabase.rpc("store_channel_token", {
      p_channel_id: opts.channelId,
      p_refresh_token: opts.refreshToken,
      p_meta: {
        youtube_channel_id: opts.youtube.id,
        youtube_channel_title: opts.youtube.title || null,
        scopes: requestedScopesOnly(opts.grantedScopes, YOUTUBE_OAUTH_SCOPES),
        oauth_client_id: GOOGLE_CLIENT_ID || null,
      },
    });
    return error ? storeErrorResult(error) : "connected";
  } catch {
    return "failed";
  }
}

/** Revoke through revoke_channel_token. `revoked` is false when there was no
 *  active connection. */
export async function revokeVaultToken(
  channelId: string,
): Promise<{ ok: true; revoked: boolean } | { ok: false; error: "not_available" | "forbidden" | "failed" }> {
  const supabase = await createClient();
  if (!supabase) return { ok: false, error: "not_available" };
  try {
    const { data, error } = await supabase.rpc("revoke_channel_token", { p_channel_id: channelId });
    if (error) {
      if (isMissingFunction(error)) return { ok: false, error: "not_available" };
      return { ok: false, error: error.code === "42501" ? "forbidden" : "failed" };
    }
    return { ok: true, revoked: data === true };
  } catch {
    return { ok: false, error: "failed" };
  }
}

/**
 * Connection status for every channel the caller can view. `available` is
 * false when 0022 is not applied — the page then says so instead of showing
 * every channel as "not connected".
 */
export async function fetchTokenStatuses(): Promise<{ available: boolean; rows: ChannelTokenStatus[] }> {
  const supabase = await createClient();
  if (!supabase) return { available: false, rows: [] };
  try {
    const { data, error } = await supabase.rpc("channel_token_status", { p_channel_id: null });
    if (error) return { available: false, rows: [] };
    return { available: true, rows: coerceTokenStatuses(data) };
  } catch {
    return { available: false, rows: [] };
  }
}
