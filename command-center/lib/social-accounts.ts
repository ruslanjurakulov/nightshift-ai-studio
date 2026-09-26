/**
 * Instagram / TikTok account connections (migration 0028) — the pure half.
 *
 * Client-safe: types and the decisions worth unit-testing. Nothing here ever
 * sees a token: social_accounts has no token column, and the tokens live in
 * Supabase Vault where only the worker (service key) can read them. The server
 * half — OAuth, the RPCs — is lib/server/social-oauth.ts and
 * lib/server/social-accounts.ts.
 */

import { atLeast, type Role } from "@/lib/auth/roles-shared";
import { isMissingFunction } from "@/lib/orgs";

export const SOCIAL_PLATFORMS = ["instagram", "tiktok"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export function isSocialPlatform(v: unknown): v is SocialPlatform {
  return v === "instagram" || v === "tiktok";
}

export type SocialAccountStatus = "connected" | "expired" | "error" | "revoked";

/** One row of social_accounts, as RLS hands it to an organization member. */
export interface SocialAccount {
  id: string;
  org_id: string;
  platform: SocialPlatform;
  external_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  status: SocialAccountStatus;
  scopes: string[];
  connected_at: string | null;
  connected_by_email: string | null;
  revoked_at: string | null;
}

/** The columns the Command Center reads — never `*`, so a column added later
 *  is not shipped to a browser by accident. */
export const SOCIAL_ACCOUNT_COLUMNS =
  "id, org_id, platform, external_id, username, display_name, avatar_url, status, scopes, connected_at, connected_by_email, revoked_at";

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

const STATUSES: SocialAccountStatus[] = ["connected", "expired", "error", "revoked"];

/** Only an https avatar is rendered; anything else is dropped. */
export function safeAvatarUrl(v: unknown): string | null {
  const s = str(v);
  if (!s || s.length > 2048) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Validate rows from the table. A row without an id or a known platform is dropped. */
export function coerceSocialAccounts(data: unknown): SocialAccount[] {
  if (!Array.isArray(data)) return [];
  const out: SocialAccount[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = str(r.id);
    const org = str(r.org_id);
    const ext = str(r.external_id);
    if (!id || !org || !ext || !isSocialPlatform(r.platform)) continue;
    const status = STATUSES.includes(r.status as SocialAccountStatus) ? (r.status as SocialAccountStatus) : "error";
    out.push({
      id,
      org_id: org,
      platform: r.platform,
      external_id: ext,
      username: str(r.username),
      display_name: str(r.display_name),
      avatar_url: safeAvatarUrl(r.avatar_url),
      status,
      scopes: Array.isArray(r.scopes) ? r.scopes.filter((s): s is string => typeof s === "string") : [],
      connected_at: str(r.connected_at),
      connected_by_email: str(r.connected_by_email),
      revoked_at: str(r.revoked_at),
    });
  }
  return out;
}

/** What to show as the account's name: display name, then @username, then id. */
export function accountLabel(a: Pick<SocialAccount, "display_name" | "username" | "external_id">): string {
  return a.display_name || (a.username ? `@${a.username}` : a.external_id);
}

/** What the panel may offer. Presentation only — routes and the database check again. */
export function socialPanelActions(opts: {
  role: Role;
  configured: boolean;
  available: boolean;
}): { connect: boolean; disconnect: boolean } {
  const editor = atLeast(opts.role, "editor");
  return {
    connect: editor && opts.configured && opts.available,
    disconnect: editor && opts.available,
  };
}

/** Result words the callbacks may put in `?social=`. */
export const SOCIAL_RESULTS = [
  "connected",
  "denied",
  "not_configured",
  "not_available",
  "forbidden",
  "not_found",
  "bad_state",
  "missing_scopes",
  "not_business",
  "no_account",
  "exchange_rejected",
  "unavailable",
  "failed",
] as const;
export type SocialResult = (typeof SOCIAL_RESULTS)[number];

/** A `?social=` value from the URL, or null when it is not one of ours — the
 *  page never echoes arbitrary query text. */
export function parseSocialResult(raw: string | null | undefined): SocialResult | null {
  const v = (raw ?? "").trim();
  return (SOCIAL_RESULTS as readonly string[]).includes(v) ? (v as SocialResult) : null;
}

/** Map a store_social_account error to a result word. Reads the SQLSTATE and
 *  nothing else; nothing from the error reaches the browser. */
export function socialStoreErrorResult(error: { code?: string | null; message?: string | null }): SocialResult {
  if (isMissingFunction({ code: error.code ?? "", message: error.message ?? "" })) return "not_available";
  if (error.code === "42501") return "forbidden";
  return "failed";
}

/** Required scopes the grant lacks (a consent screen may let one be unticked). */
export function missingSocialScopes(granted: readonly string[], required: readonly string[]): string[] {
  const have = new Set(granted);
  return required.filter((s) => !have.has(s));
}

/** The one path a callback redirects to. Fixed, same-origin, and carrying only
 *  a known result word and platform — never anything from the request. */
export function socialReturnPath(platform: SocialPlatform, result: SocialResult): string {
  const p = new URLSearchParams({ social: result, platform });
  return `/all-channels/channels?${p.toString()}`;
}

/** The shape the header's connected-accounts list uses (lib/connectedAccounts.ts). */
export interface ConnectedSocialAccount {
  platform: SocialPlatform;
  id: string;
  name: string;
  avatarUrl: string | null;
  connected: boolean;
}

export function toConnectedAccounts(rows: SocialAccount[]): ConnectedSocialAccount[] {
  return rows
    .filter((r) => r.status !== "revoked")
    .map((r) => ({
      platform: r.platform,
      id: r.id,
      name: accountLabel(r),
      avatarUrl: r.avatar_url,
      connected: r.status === "connected",
    }));
}

/** Where access is removed on the platform's side after a disconnect. */
export const PLATFORM_PERMISSIONS_URL: Record<SocialPlatform, string> = {
  instagram: "https://www.instagram.com/accounts/manage_access/",
  tiktok: "https://www.tiktok.com/setting/security",
};
