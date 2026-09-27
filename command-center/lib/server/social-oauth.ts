import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { SocialPlatform } from "@/lib/social-accounts";

/**
 * Instagram / TikTok OAuth — the server half of connecting an account.
 *
 * The flow mirrors app/api/oauth/youtube/*: the start route sets an httpOnly
 * nonce cookie and sends the browser to the platform's consent screen with
 * that nonce inside `state`; the callback checks the nonce, exchanges the
 * one-time `code` for tokens, reads the account's public profile, and hands
 * the tokens to store_social_account (migration 0028), which seals them into
 * Supabase Vault. A token passes through exactly one RPC argument and is never
 * logged, returned to the browser, or put in an error message.
 *
 * Client ids and secrets live in server-only env vars. This file is
 * `server-only`, so importing it from a client component fails the build.
 *
 * Official references (read 2026-09):
 * - Instagram API with Instagram Login, Business Login:
 *   https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
 *   authorize  https://www.instagram.com/oauth/authorize
 *   code →     POST https://api.instagram.com/oauth/access_token (short-lived token, 1 h)
 *   short →    GET  https://graph.instagram.com/access_token?grant_type=ig_exchange_token (long-lived, 60 days)
 *   refresh    GET  https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token
 *              https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token/
 *   profile    GET  https://graph.instagram.com/<ver>/me?fields=user_id,username,name,profile_picture_url,account_type
 * - TikTok Login Kit for Web + token management:
 *   https://developers.tiktok.com/doc/login-kit-web
 *   https://developers.tiktok.com/doc/oauth-user-access-token-management
 *   authorize  https://www.tiktok.com/v2/auth/authorize/
 *   code →     POST https://open.tiktokapis.com/v2/oauth/token/ (access 24 h, refresh 365 days)
 *   profile    GET  https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name
 *   PKCE: TikTok derives code_challenge as the HEX SHA-256 of the verifier
 *   (not base64url as in RFC 7636). Instagram Login has no PKCE; the state
 *   nonce cookie is the CSRF protection there.
 */

export const INSTAGRAM_GRAPH_VERSION = "v23.0";

export const INSTAGRAM_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"] as const;
export const TIKTOK_SCOPES = ["user.info.basic", "video.publish", "video.upload"] as const;
/** What a TikTok grant must include to be usable for publishing. */
export const TIKTOK_REQUIRED_SCOPES = ["user.info.basic", "video.publish"] as const;

const IG_AUTHORIZE = "https://www.instagram.com/oauth/authorize";
const IG_TOKEN = "https://api.instagram.com/oauth/access_token";
const IG_GRAPH = "https://graph.instagram.com";
const TT_AUTHORIZE = "https://www.tiktok.com/v2/auth/authorize/";
const TT_TOKEN = "https://open.tiktokapis.com/v2/oauth/token/";
const TT_USER_INFO = "https://open.tiktokapis.com/v2/user/info/";

/** Read at call time, so a deploy that adds the keys needs no rebuild. Each
 *  name is a literal so tests/test_deploy_self_host.py can see what is read. */
export function socialOAuthConfig(platform: SocialPlatform): { id: string; secret: string; configured: boolean } {
  const id = (platform === "instagram" ? process.env.INSTAGRAM_APP_ID : process.env.TIKTOK_CLIENT_KEY) ?? "";
  const secret = (platform === "instagram" ? process.env.INSTAGRAM_APP_SECRET : process.env.TIKTOK_CLIENT_SECRET) ?? "";
  return { id: id.trim(), secret: secret.trim(), configured: Boolean(id.trim() && secret.trim()) };
}

export function isSocialConfigured(platform: SocialPlatform): boolean {
  return socialOAuthConfig(platform).configured;
}

/** The redirect URI registered on the platform app. */
export function socialRedirectUri(platform: SocialPlatform, origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/oauth/${platform}/callback`;
}

// ─── state + nonce + PKCE ────────────────────────────────────────────────────

export interface SocialState {
  org: string;
  nonce: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

export function encodeSocialState(value: SocialState): string {
  return Buffer.from(JSON.stringify({ org: value.org, nonce: value.nonce }), "utf8").toString("base64url");
}

/** The state is a claim, not an authority: the callback re-checks the org role.
 *  Anything that is not exactly {org: uuid, nonce} is refused. */
export function decodeSocialState(raw: string | null | undefined): SocialState | null {
  if (!raw || raw.length > 512) return null;
  try {
    const obj = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (obj && typeof obj.org === "string" && typeof obj.nonce === "string" && UUID_RE.test(obj.org) && NONCE_RE.test(obj.nonce)) {
      return { org: obj.org, nonce: obj.nonce };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Constant-time nonce comparison. */
export function nonceMatches(cookie: string | null | undefined, state: string | null | undefined): boolean {
  if (!cookie || !state) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(state);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const NONCE_COOKIE: Record<SocialPlatform, string> = {
  instagram: "ig_oauth_nonce",
  tiktok: "tt_oauth_nonce",
};
export const PKCE_COOKIE = "tt_oauth_pkce";

/** Read one cookie by name from the request header. */
export function readCookie(request: Request, name: string): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** RFC 7636 verifier: 43–128 chars of [A-Za-z0-9-._~]. base64url is a subset. */
export function newCodeVerifier(): string {
  return randomBytes(48).toString("base64url"); // 64 chars
}

/** TikTok's code_challenge: HEX-encoded SHA-256 of the verifier. */
export function tiktokCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("hex");
}

// ─── consent URLs ────────────────────────────────────────────────────────────

export function buildInstagramAuthUrl(opts: { origin: string; state: string }): string {
  const { id } = socialOAuthConfig("instagram");
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: socialRedirectUri("instagram", opts.origin),
    response_type: "code",
    scope: INSTAGRAM_SCOPES.join(","),
    state: opts.state,
  });
  return `${IG_AUTHORIZE}?${params.toString()}`;
}

export function buildTiktokAuthUrl(opts: { origin: string; state: string; codeChallenge: string }): string {
  const { id } = socialOAuthConfig("tiktok");
  const params = new URLSearchParams({
    client_key: id,
    redirect_uri: socialRedirectUri("tiktok", opts.origin),
    response_type: "code",
    scope: TIKTOK_SCOPES.join(","),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${TT_AUTHORIZE}?${params.toString()}`;
}

// ─── exchanges (errors carry our words and HTTP status only) ─────────────────

export class SocialOAuthError extends Error {
  constructor(public readonly reason: "exchange_rejected" | "failed" | "no_account" | "not_business") {
    super(reason);
  }
}

async function jsonOrThrow(res: Response): Promise<Record<string, unknown>> {
  if (!res.ok) throw new SocialOAuthError(res.status === 400 || res.status === 401 ? "exchange_rejected" : "failed");
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    throw new SocialOAuthError("failed");
  }
}

export interface InstagramGrant {
  accessToken: string; // long-lived
  expiresIn: number | null;
  scopes: string[];
  userId: string;
}

/** Split Instagram's "a,b" permission list (or an array). */
export function splitScopes(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === "string" && Boolean(s));
  if (typeof v !== "string") return [];
  return v.split(/[\s,]+/).filter(Boolean);
}

/** Code → short-lived → long-lived Instagram user token. */
export async function exchangeInstagramCode(opts: { code: string; origin: string }): Promise<InstagramGrant> {
  const { id, secret } = socialOAuthConfig("instagram");
  const shortRes = await fetch(IG_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    cache: "no-store",
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      grant_type: "authorization_code",
      redirect_uri: socialRedirectUri("instagram", opts.origin),
      code: opts.code,
    }).toString(),
  });
  const shortBody = await jsonOrThrow(shortRes);
  // Documented as { data: [ { access_token, user_id, permissions } ] }; older
  // responses were the object itself. Accept both.
  const first = Array.isArray(shortBody.data) ? (shortBody.data[0] as Record<string, unknown> | undefined) : shortBody;
  const shortToken = typeof first?.access_token === "string" ? first.access_token : "";
  const userId = first?.user_id != null ? String(first.user_id) : "";
  const scopes = splitScopes(first?.permissions);
  if (!shortToken) throw new SocialOAuthError("failed");

  const longUrl = new URL(`${IG_GRAPH}/access_token`);
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", secret);
  longUrl.searchParams.set("access_token", shortToken);
  const longBody = await jsonOrThrow(await fetch(longUrl, { cache: "no-store" }));
  const accessToken = typeof longBody.access_token === "string" ? longBody.access_token : "";
  if (!accessToken) throw new SocialOAuthError("failed");
  return {
    accessToken,
    expiresIn: typeof longBody.expires_in === "number" ? longBody.expires_in : null,
    scopes,
    userId,
  };
}

export interface SocialProfile {
  externalId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

function cut(v: unknown, n: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null;
}

/** The professional account the token acts for. `user_id` is the IG
 *  professional account id the content-publishing endpoints take. */
export async function fetchInstagramProfile(accessToken: string): Promise<SocialProfile> {
  const url = new URL(`${IG_GRAPH}/${INSTAGRAM_GRAPH_VERSION}/me`);
  url.searchParams.set("fields", "user_id,username,name,profile_picture_url,account_type");
  url.searchParams.set("access_token", accessToken);
  const body = await jsonOrThrow(await fetch(url, { cache: "no-store" }));
  const externalId = body.user_id != null ? String(body.user_id) : body.id != null ? String(body.id) : "";
  if (!externalId) throw new SocialOAuthError("no_account");
  const type = typeof body.account_type === "string" ? body.account_type.toUpperCase() : "";
  if (type && type !== "BUSINESS" && type !== "MEDIA_CREATOR") throw new SocialOAuthError("not_business");
  return {
    externalId,
    username: cut(body.username, 100),
    displayName: cut(body.name, 200),
    avatarUrl: cut(body.profile_picture_url, 2048),
  };
}

export interface TiktokGrant {
  accessToken: string;
  refreshToken: string;
  expiresIn: number | null;
  refreshExpiresIn: number | null;
  openId: string;
  scopes: string[];
}

export async function exchangeTiktokCode(opts: { code: string; origin: string; codeVerifier: string }): Promise<TiktokGrant> {
  const { id, secret } = socialOAuthConfig("tiktok");
  const res = await fetch(TT_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    cache: "no-store",
    body: new URLSearchParams({
      client_key: id,
      client_secret: secret,
      code: opts.code,
      grant_type: "authorization_code",
      redirect_uri: socialRedirectUri("tiktok", opts.origin),
      code_verifier: opts.codeVerifier,
    }).toString(),
  });
  const body = await jsonOrThrow(res);
  // TikTok reports a refused exchange with HTTP 200 and an `error` field.
  if (typeof body.error === "string" && body.error) throw new SocialOAuthError("exchange_rejected");
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  if (!accessToken || !refreshToken) throw new SocialOAuthError("failed");
  return {
    accessToken,
    refreshToken,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
    refreshExpiresIn: typeof body.refresh_expires_in === "number" ? body.refresh_expires_in : null,
    openId: typeof body.open_id === "string" ? body.open_id : "",
    scopes: splitScopes(body.scope),
  };
}

export async function fetchTiktokProfile(accessToken: string, openId: string): Promise<SocialProfile> {
  const url = new URL(TT_USER_INFO);
  url.searchParams.set("fields", "open_id,avatar_url,display_name");
  const body = await jsonOrThrow(
    await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" }),
  );
  const user = ((body.data as Record<string, unknown> | undefined)?.user ?? {}) as Record<string, unknown>;
  const externalId = typeof user.open_id === "string" && user.open_id ? user.open_id : openId;
  if (!externalId) throw new SocialOAuthError("no_account");
  return {
    externalId,
    username: null,
    displayName: cut(user.display_name, 200),
    avatarUrl: cut(user.avatar_url, 2048),
  };
}
