/**
 * What an API key may do (migration 0062) — the pure half, shared by the
 * Developer console that picks a key's scopes and the docs that list them.
 * The database decides (api_begin refuses an endpoint outside the key's
 * scopes); this is the TypeScript twin of api_scopes_valid / api_legacy_scopes /
 * api_endpoint_scope, and tests/api-scopes.test.ts pins the two together.
 */

export const API_SCOPES = [
  "account:read",
  "videos:read",
  "videos:write",
  "creative:quote",
  "creative:create",
  "creative:read",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** What a key made before 0062 may do: what it could always do. Never a creative scope. */
export const LEGACY_SCOPES: readonly ApiScope[] = ["account:read", "videos:read", "videos:write"];

/** The scopes that start (and so spend credits on) generations, or read them. */
export const CREATIVE_SCOPES: readonly ApiScope[] = ["creative:quote", "creative:create", "creative:read"];

/** The scope each endpoint needs; /me needs none. Must equal api_endpoint_scope in 0062. */
export const ENDPOINT_SCOPES: Record<string, ApiScope | null> = {
  me: null,
  balance: "account:read",
  "channels.list": "account:read",
  "accounts.list": "account:read",
  "videos.list": "videos:read",
  "videos.get": "videos:read",
  "jobs.get": "videos:read",
  "downloads.get": "videos:read",
  "videos.create": "videos:write",
  "videos.publish": "videos:write",
  "downloads.create": "videos:write",
  "creative.quote": "creative:quote",
  "creative.create": "creative:create",
  "creative.get": "creative:read",
};

/** The most requests a minute a key may be given (the top tier's own limit). */
export const KEY_RPM_MAX = 300;

export function isApiScope(v: unknown): v is ApiScope {
  return typeof v === "string" && (API_SCOPES as readonly string[]).includes(v);
}

/** A key's scopes as the API reads them: a key with none recorded is a pre-0062 key. */
export function effectiveScopes(scopes: readonly string[] | null | undefined): readonly ApiScope[] {
  if (!Array.isArray(scopes)) return LEGACY_SCOPES;
  return scopes.filter(isApiScope);
}

/** "" -> no limit; else a whole number of requests per minute, 1..300. */
export function parseRpmLimit(text: string): { ok: true; value: number | null } | { ok: false } {
  const s = text.trim();
  if (s === "") return { ok: true, value: null };
  if (!/^\d{1,3}$/.test(s)) return { ok: false };
  const n = Number(s);
  return n >= 1 && n <= KEY_RPM_MAX ? { ok: true, value: n } : { ok: false };
}

/** "" -> no limit; else credits (up to two decimals) a month, 0..100,000,000. */
export function parseCreditLimit(text: string): { ok: true; value: number | null } | { ok: false } {
  const s = text.trim().replace(",", ".");
  if (s === "") return { ok: true, value: null };
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return { ok: false };
  const n = Number(s);
  return n >= 0 && n <= 100_000_000 ? { ok: true, value: n } : { ok: false };
}

/** What the browser sends to create_scoped_api_key (0062): which organization,
 *  a name, the limits and the scopes — nothing of a key, which the database mints. */
export function createScopedKeyArgs(
  orgId: string,
  name: string,
  limitCents: number | null,
  scopes: readonly ApiScope[],
  rpmLimit: number | null,
  creativeMonthlyCredits: number | null,
) {
  return {
    p_org: orgId,
    p_name: name.slice(0, 60),
    p_monthly_limit_cents: limitCents,
    p_scopes: [...new Set(scopes)].sort(),
    p_rpm_limit: rpmLimit,
    p_creative_monthly_credits: creativeMonthlyCredits,
  };
}
