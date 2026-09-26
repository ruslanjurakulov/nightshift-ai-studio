/**
 * Customer channels' YouTube connection (migration 0022) — the pure half.
 *
 * Client-safe: types, and the decisions worth unit-testing. Nothing here ever
 * sees a token — the database never returns one to a browser, and the only
 * fields that reach this file are channel_token_status()'s non-secret ones.
 * The server half (Supabase RPCs, the YouTube lookup) is
 * lib/server/channel-tokens.ts.
 */

import { atLeast, type Role } from "@/lib/auth/roles-shared";
import { DEFAULT_ORG_ID, isMissingFunction } from "@/lib/orgs";

/** Where a channel's upload token is kept, which decides who may connect it. */
export type TokenStore =
  /** The operator's own channels: a GitHub Actions secret, platform admin only — unchanged. */
  | { mode: "github" }
  /** A customer organization's channel: Supabase Vault, that organization's admin. */
  | { mode: "vault"; orgId: string }
  /** The organization lookup failed: refuse rather than guess the weaker gate. */
  | { mode: "unavailable" };

/**
 * Decide the store from `channel_org(ref)`'s answer.
 *
 * - no organizations yet (0018 missing), an unknown ref, or the default org →
 *   the GitHub-secret path, exactly as before this feature;
 * - any other organization → Vault;
 * - a lookup that failed for another reason → unavailable (fail closed).
 */
export function decideTokenStore(answer: {
  orgId: string | null;
  missingFunction?: boolean;
  failed?: boolean;
}): TokenStore {
  if (answer.missingFunction) return { mode: "github" };
  if (answer.failed) return { mode: "unavailable" };
  if (!answer.orgId || answer.orgId === DEFAULT_ORG_ID) return { mode: "github" };
  return { mode: "vault", orgId: answer.orgId };
}

/** One row of channel_token_status(). */
export interface ChannelTokenStatus {
  channel_id: string;
  connected: boolean;
  youtube_channel_id: string | null;
  youtube_channel_title: string | null;
  google_account_email: string | null;
  scopes: string[];
  connected_at: string | null;
  connected_by_email: string | null;
  revoked_at: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** Validate the RPC's rows. A row without a channel id is dropped. */
export function coerceTokenStatuses(data: unknown): ChannelTokenStatus[] {
  if (!Array.isArray(data)) return [];
  const out: ChannelTokenStatus[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const channelId = str(r.channel_id);
    if (!channelId) continue;
    out.push({
      channel_id: channelId,
      connected: r.connected === true,
      youtube_channel_id: str(r.youtube_channel_id),
      youtube_channel_title: str(r.youtube_channel_title),
      google_account_email: str(r.google_account_email),
      scopes: Array.isArray(r.scopes) ? r.scopes.filter((s): s is string => typeof s === "string") : [],
      connected_at: str(r.connected_at),
      connected_by_email: str(r.connected_by_email),
      revoked_at: str(r.revoked_at),
    });
  }
  return out;
}

/** Required scopes the grant lacks. Google's consent screen lets a user untick
 *  one; the pipeline then fails at the step that needed it. */
export function missingScopes(granted: readonly string[], required: readonly string[]): string[] {
  const have = new Set(granted);
  return required.filter((s) => !have.has(s));
}

/** "https://www.googleapis.com/auth/youtube.upload" → "youtube.upload". */
export function shortScope(scope: string): string {
  return scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, "");
}

/** Only the scopes the connect flow asked for — Google may add previously
 *  granted ones (include_granted_scopes), which 0022 would refuse. */
export function requestedScopesOnly(granted: readonly string[], requested: readonly string[]): string[] {
  const want = new Set(requested);
  return [...new Set(granted.filter((s) => want.has(s)))].sort();
}

/** What the channel page may offer. Presentation only — the route and the
 *  database both check again. */
export function tokenPanelActions(opts: {
  role: Role;
  oauthConfigured: boolean;
  available: boolean;
  connected: boolean;
}): { connect: boolean; disconnect: boolean } {
  const admin = atLeast(opts.role, "admin");
  return {
    connect: admin && opts.oauthConfigured && opts.available,
    disconnect: admin && opts.available && opts.connected,
  };
}

/** Result words the callback may put in `?yt=` for a Vault connection. */
export const VAULT_RESULTS = [
  "connected",
  "denied",
  "no_refresh",
  "not_configured",
  "forbidden",
  "not_found",
  "bad_state",
  "missing_scopes",
  "no_channel",
  "wrong_channel",
  "not_available",
  "unavailable",
  "exchange_rejected",
  "failed",
] as const;
export type VaultResult = (typeof VAULT_RESULTS)[number];

/** A `?yt=` value from the URL, or null when it is not one of ours — the page
 *  never echoes arbitrary query text. */
export function parseVaultResult(raw: string | null | undefined): VaultResult | null {
  const v = (raw ?? "").trim();
  return (VAULT_RESULTS as readonly string[]).includes(v) ? (v as VaultResult) : null;
}

/** Map a store_channel_token error to a result word. Reads the SQLSTATE and
 *  our own message markers only; nothing from the error reaches the browser. */
export function storeErrorResult(error: { code?: string | null; message?: string | null }): VaultResult {
  const code = error.code ?? "";
  const message = error.message ?? "";
  if (isMissingFunction({ code, message })) return "not_available";
  if (message.includes("wrong_youtube_channel")) return "wrong_channel";
  if (code === "42501") return "forbidden";
  return "failed";
}

/** Where Google access is removed on Google's side. */
export const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";
