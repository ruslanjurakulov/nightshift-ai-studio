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
 * Official references:
 * - Instagram API with Unified Login (Meta's docs, read 2026-11-21). The person signs in with Facebook, picks a
 *   business portfolio and then one or more of its Instagram professional accounts; each portfolio is its own
 *   connection with its own token.
 *   authorize  https://www.facebook.com/dialog/oauth?client_id&config_id&redirect_uri&response_type=code&state
 *              NO `scope`: the permissions live in the Meta configuration that config_id names (the owner sets
 *              them there: instagram_basic, instagram_content_publish, instagram_manage_comments,
 *              instagram_manage_messages, instagram_manage_insights; docs/SOCIAL_SETUP.md).
 *              A cancel comes back as ?error=access_denied&error_reason=user_denied.
 *   code →     GET  https://graph.facebook.com/<ver>/oauth/access_token?client_id&client_secret&code&redirect_uri
 *              (redirect_uri must equal the login's). Returns a Business Integration System User token that does
 *              not expire by default and has no refresh endpoint: a missing or 0 `expires_in` is "no expiry
 *              stated" (null), never a number. The answer names no granted scopes, so none are claimed.
 *   accounts   GET  https://graph.facebook.com/<ver>/me?fields=client_business_id
 *              GET  https://graph.facebook.com/<ver>/me/assigned_instagram_accounts?fields=id,username
 *              (not /me/accounts). Each `id` is the IG account id the publishing endpoints take.
 *   There is no account_type field here; a personal account is refused by the publishing call (error #10),
 *   which modules/social_publish.py names.
 * - TikTok Login Kit for Web + token management:
 *   https://developers.tiktok.com/doc/login-kit-web
 *   https://developers.tiktok.com/doc/oauth-user-access-token-management
 *   authorize  https://www.tiktok.com/v2/auth/authorize/
 *   code →     POST https://open.tiktokapis.com/v2/oauth/token/ (access 24 h, refresh 365 days)
 *   profile    GET  https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name
 *   PKCE: TikTok derives code_challenge as the HEX SHA-256 of the verifier
 *   (not base64url as in RFC 7636). The Facebook login dialog has no PKCE here;
 *   the state nonce cookie is the CSRF protection there.
 */

export const INSTAGRAM_GRAPH_VERSION = "v27.0";

export const TIKTOK_SCOPES = ["user.info.basic", "video.publish", "video.upload"] as const;
/** What a TikTok grant must include to be usable for publishing. */
export const TIKTOK_REQUIRED_SCOPES = ["user.info.basic", "video.publish"] as const;

const IG_AUTHORIZE = "https://www.facebook.com/dialog/oauth";
const IG_GRAPH = `https://graph.facebook.com/${INSTAGRAM_GRAPH_VERSION}`;
/** The most IG accounts one connection is read for: a hostile or odd answer cannot fill the server's memory. */
const IG_MAX_ACCOUNTS = 50;
/** The most pages of /me/assigned_instagram_accounts followed (a paging loop cannot run for ever). */
const IG_MAX_PAGES = 10;
/** A Meta id: digits only (the configuration id, the business portfolio id, an IG account id). */
const META_ID_RE = /^[0-9]{1,64}$/;
const TT_AUTHORIZE = "https://www.tiktok.com/v2/auth/authorize/";
const TT_TOKEN = "https://open.tiktokapis.com/v2/oauth/token/";
const TT_USER_INFO = "https://open.tiktokapis.com/v2/user/info/";

/** Read at call time, so a deploy that adds the keys needs no rebuild. Each
 *  name is a literal so tests/test_deploy_self_host.py can see what is read.
 *
 *  Instagram: INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET are the META app's id and secret (the app that holds the
 *  "Instagram API with Unified Login" use case), and INSTAGRAM_CONFIG_ID is the Unified Login configuration's id
 *  (not a secret: it travels in the login URL). All three are needed; one missing is "not configured", so the
 *  Connect button says "not available yet" instead of starting a login Meta would refuse. */
export function socialOAuthConfig(platform: SocialPlatform): { id: string; secret: string; configId: string | null; configured: boolean } {
  const id = ((platform === "instagram" ? process.env.INSTAGRAM_APP_ID : process.env.TIKTOK_CLIENT_KEY) ?? "").trim();
  const secret = ((platform === "instagram" ? process.env.INSTAGRAM_APP_SECRET : process.env.TIKTOK_CLIENT_SECRET) ?? "").trim();
  if (platform !== "instagram") return { id, secret, configId: null, configured: Boolean(id && secret) };
  const raw = (process.env.INSTAGRAM_CONFIG_ID ?? "").trim();
  // A malformed id is as unusable as a missing one, and Meta would refuse it only after the person signed in.
  const configId = META_ID_RE.test(raw) ? raw : null;
  return { id, secret, configId, configured: Boolean(id && secret && configId) };
}

export function isSocialConfigured(platform: SocialPlatform): boolean {
  return socialOAuthConfig(platform).configured;
}

const ORG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** INSTAGRAM_UNIFIED_ORGS: the organizations (uuids, comma or space separated; anything else skipped) that may use the
 *  Unified Login Instagram connect. Empty by default = nobody. Not a secret: org ids. */
export function instagramUnifiedOrgs(): ReadonlySet<string> {
  return new Set(
    (process.env.INSTAGRAM_UNIFIED_ORGS ?? "")
      .split(/[\s,]+/)
      .map((x) => x.trim().toLowerCase())
      .filter((x) => ORG_UUID_RE.test(x)),
  );
}

/**
 * May this organization start a connect on this platform? Configured, and for Instagram also on the allowlist.
 *
 * Why the allowlist: the Meta app is Unpublished (development mode) until App Review, so only people with a role on
 * the app can sign in. Offering the button to everyone would send every other workspace into a Facebook login that
 * Meta refuses. Everyone else sees "not available yet". The start AND the callback ask this (not just the page), so a
 * hand-typed /api/oauth/instagram/start from another workspace is refused before Meta is involved.
 */
export function socialConnectOpen(platform: SocialPlatform, orgId: string | null | undefined): boolean {
  if (!isSocialConfigured(platform)) return false;
  if (platform !== "instagram") return true;
  return Boolean(orgId) && instagramUnifiedOrgs().has(String(orgId).toLowerCase());
}

/** The redirect URI registered on the platform app. */
export function socialRedirectUri(platform: SocialPlatform, origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/oauth/${platform}/callback`;
}

// ─── state + nonce + PKCE ────────────────────────────────────────────────────

export interface SocialState {
  org: string;
  nonce: string;
  /** Connect-then-confirm: hold the grant for the confirm screen instead of storing it. */
  pick?: true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

export function encodeSocialState(value: SocialState): string {
  return Buffer.from(
    JSON.stringify({ org: value.org, nonce: value.nonce, ...(value.pick ? { pick: true } : {}) }),
    "utf8",
  ).toString("base64url");
}

/** The state is a claim, not an authority: the callback re-checks the org role.
 *  Anything that is not exactly {org: uuid, nonce} is refused. */
export function decodeSocialState(raw: string | null | undefined): SocialState | null {
  if (!raw || raw.length > 512) return null;
  try {
    const obj = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (obj && typeof obj.org === "string" && typeof obj.nonce === "string" && UUID_RE.test(obj.org) && NONCE_RE.test(obj.nonce)) {
      return obj.pick === true ? { org: obj.org, nonce: obj.nonce, pick: true } : { org: obj.org, nonce: obj.nonce };
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

/** The Facebook login dialog for the Unified Login configuration. Throws when the configuration id is not set:
 *  the start route checks isSocialConfigured first, so this is the last line, never a login without config_id. */
export function buildInstagramAuthUrl(opts: { origin: string; state: string }): string {
  const { id, configId } = socialOAuthConfig("instagram");
  if (!configId) throw new SocialOAuthError("not_configured");
  const params = new URLSearchParams({
    client_id: id,
    config_id: configId,
    redirect_uri: socialRedirectUri("instagram", opts.origin),
    response_type: "code",
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
  constructor(public readonly reason: "exchange_rejected" | "failed" | "no_account" | "not_business" | "not_configured") {
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
  accessToken: string; // a Business Integration System User token
  /** Seconds, only when Meta stated a positive lifetime; null = no expiry stated (the default for this token). */
  expiresIn: number | null;
}

/** Split a "a,b" permission list (or an array). */
export function splitScopes(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === "string" && Boolean(s));
  if (typeof v !== "string") return [];
  return v.split(/[\s,]+/).filter(Boolean);
}

/** A token lifetime Meta stated: a finite positive number of seconds. 0, a missing field and anything else are
 *  "no expiry stated", which is stored as null and never shown as a date. */
export function statedLifetime(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

/** The one server-to-server exchange: code → BISU token. The secret goes to graph.facebook.com in the query, as
 *  Meta documents it; the URL is never logged and an error carries only our word. */
export async function exchangeInstagramCode(opts: { code: string; origin: string }): Promise<InstagramGrant> {
  const { id, secret } = socialOAuthConfig("instagram");
  const url = new URL(`${IG_GRAPH}/oauth/access_token`);
  url.searchParams.set("client_id", id);
  url.searchParams.set("client_secret", secret);
  url.searchParams.set("code", opts.code);
  // Must equal the login's byte for byte, or Meta refuses the code.
  url.searchParams.set("redirect_uri", socialRedirectUri("instagram", opts.origin));
  const body = await jsonOrThrow(await fetch(url, { cache: "no-store" }));
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  if (!accessToken) throw new SocialOAuthError("failed");
  return { accessToken, expiresIn: statedLifetime(body.expires_in) };
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

export interface InstagramAccounts {
  /** The client's business portfolio, when Meta returned one. Never guessed. */
  clientBusinessId: string | null;
  /** The IG professional accounts this connection may act for, in Meta's order, without duplicates. */
  accounts: SocialProfile[];
}

function metaGet(path: string, fields: string, accessToken: string): Promise<Response> {
  const url = new URL(`${IG_GRAPH}/${path}`);
  url.searchParams.set("fields", fields);
  url.searchParams.set("access_token", accessToken);
  return fetch(url, { cache: "no-store" });
}

/** The business portfolio and the IG accounts assigned to the connection's system user. Zero accounts is
 *  `no_account` (the person picked none, or the portfolio has none). */
export async function fetchInstagramAccounts(accessToken: string): Promise<InstagramAccounts> {
  const me = await jsonOrThrow(await metaGet("me", "client_business_id", accessToken));
  const biz = typeof me.client_business_id === "string" ? me.client_business_id : "";
  const accounts: SocialProfile[] = [];
  const seen = new Set<string>();
  let page = await jsonOrThrow(await metaGet("me/assigned_instagram_accounts", "id,username", accessToken));
  for (let pages = 1; ; pages++) {
    const data = Array.isArray(page.data) ? page.data : [];
    for (const raw of data) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      // A JSON string only: an IG id is 17+ digits, which a JSON number cannot hold exactly (Breach I3).
      const externalId = typeof r.id === "string" ? r.id : "";
      if (!META_ID_RE.test(externalId) || seen.has(externalId)) continue;
      seen.add(externalId);
      accounts.push({ externalId, username: cut(r.username, 100), displayName: null, avatarUrl: null });
      if (accounts.length >= IG_MAX_ACCOUNTS) break;
    }
    // Meta pages the list (paging.next, a full URL). Followed only on graph.facebook.com over https, so an answer
    // cannot send the token anywhere else, and only until the cap.
    const next = nextPage(page.paging);
    if (!next || accounts.length >= IG_MAX_ACCOUNTS || pages >= IG_MAX_PAGES) break;
    page = await jsonOrThrow(await fetch(next, { cache: "no-store" }));
  }
  if (accounts.length === 0) throw new SocialOAuthError("no_account");
  return { clientBusinessId: META_ID_RE.test(biz) ? biz : null, accounts };
}

function nextPage(paging: unknown): URL | null {
  const raw = paging && typeof paging === "object" ? (paging as Record<string, unknown>).next : null;
  if (typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.host === "graph.facebook.com" && !u.username && !u.password ? u : null;
  } catch {
    return null;
  }
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
