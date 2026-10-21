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

/**
 * Is a channel of this organization one of the OPERATOR's own (migration 0115)? Only the default organization's
 * channels can be connected through `store_operator_channel_token`; the database checks it again, and also that the
 * caller is a platform owner/admin. An unknown channel (null) is not one.
 */
export function isOperatorOrg(orgId: string | null | undefined): boolean {
  return Boolean(orgId) && orgId === DEFAULT_ORG_ID;
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
  /** The operator's own channel: connect/reconnect only. Disconnecting the channel the bot publishes with is not
   *  offered from a button (the database function exists for the owner's SQL editor). */
  operator?: boolean;
}): { connect: boolean; disconnect: boolean } {
  const admin = atLeast(opts.role, "admin");
  return {
    connect: admin && opts.oauthConfigured && opts.available,
    disconnect: admin && opts.available && opts.connected && !opts.operator,
  };
}

/** What the operator's channel card says about its YouTube token. */
export type OperatorYoutubeState = "connected" | "expired" | "not_connected";

/** The bot's last answer to "does this channel's YouTube token still refresh?" — the `youtube_token_live` check of a
 *  `credential.health` event (modules/credential_health.with_live_youtube_check). */
export interface LiveVerdict {
  ts: string;
  /** Google refused the token (the run stopped before it spent). */
  dead: boolean;
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * The newest live-check verdict per channel, from `credential.health` events (newest first or not — the order is
 * decided here). An event without the check (a run that does not upload) says nothing and is skipped. The event's
 * metadata is read as an object or as the JSON text the pipeline stores.
 */
export function latestLiveVerdicts(
  events: { channel_id: string | null; event: string; ts: string; metadata: unknown }[],
): Map<string, LiveVerdict> {
  const out = new Map<string, LiveVerdict>();
  for (const e of events) {
    if (e.event !== "credential.health" || !e.channel_id) continue;
    const meta = asObject(e.metadata);
    const checks = Array.isArray(meta?.checks) ? (meta.checks as unknown[]) : [];
    const live = checks.map(asObject).find((c) => c?.name === "youtube_token_live");
    if (!live) continue;
    const prev = out.get(e.channel_id);
    if (!prev || Date.parse(e.ts) > Date.parse(prev.ts)) out.set(e.channel_id, { ts: e.ts, dead: live.status === "missing" });
  }
  return out;
}

/**
 * connected / expired / not connected for an operator channel, from what the bot reported — never guessed:
 * - expired: the bot's last live check found the token dead AND that check is newer than the connection (a
 *   reconnect after the failure reads as connected until the next run says otherwise), or the bot's credential
 *   mirror says the token expired;
 * - connected: an active Vault connection, or the bot sees a usable token from the old GitHub secret;
 * - not connected: neither.
 */
export function operatorYoutubeState(opts: {
  token: ChannelTokenStatus | null;
  credentialStatus: string | null | undefined;
  live: LiveVerdict | undefined;
}): OperatorYoutubeState {
  const { token, credentialStatus, live } = opts;
  const connectedAt = token?.connected && token.connected_at ? Date.parse(token.connected_at) : null;
  if (live?.dead && (connectedAt === null || Date.parse(live.ts) > connectedAt)) return "expired";
  if (credentialStatus === "expired" && !token?.connected) return "expired";
  if (token?.connected) return "connected";
  if (credentialStatus === "connected") return "connected";
  return "not_connected";
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
