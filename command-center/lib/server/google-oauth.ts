import "server-only";

/**
 * Google / YouTube OAuth — the server half of connecting a channel from the site.
 *
 * The flow: the operator clicks "Connect YouTube" → we send the browser to
 * Google's consent screen → Google redirects back to our callback with a short
 * `code` → we exchange it for a refresh token → we seal the token JSON into the
 * channel's GitHub Actions secret (CHRONOS_YT_TOKEN_<REF> / YOUTUBE_TOKEN_JSON),
 * exactly the shape the bot's uploader loads with
 * `Credentials.from_authorized_user_file`. No token ever touches Supabase, a log,
 * or the browser after the redirect.
 *
 * The OAuth client id/secret live in server-only env vars. This file is
 * `server-only`, so importing it from a client component fails the build rather
 * than shipping the secret.
 */

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "";
export const isGoogleOAuthConfigured = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Scopes the bot needs: upload + read + captions/force-ssl + analytics. Must
 *  cover config.YOUTUBE_SCOPES so a granted token can do everything the pipeline
 *  asks of it. */
export const YOUTUBE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

/** The redirect URI Google calls back. Must be registered on the OAuth client. */
export function redirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/oauth/youtube/callback`;
}

/** Base64url encode/decode for the `state` blob (channel ref + CSRF nonce). */
export function encodeState(value: { ref: string; nonce: string }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeState(raw: string): { ref: string; nonce: string } | null {
  try {
    const obj = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (obj && typeof obj.ref === "string" && typeof obj.nonce === "string") {
      return { ref: obj.ref, nonce: obj.nonce };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** The consent-screen URL. `access_type=offline` + `prompt=consent` are what
 *  make Google mint a refresh token every time — without them a re-connect can
 *  come back with no refresh token and the bot could not renew access. */
export function buildAuthUrl(opts: { origin: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(opts.origin),
    response_type: "code",
    scope: YOUTUBE_OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: opts.state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface TokenExchange {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/** Exchange the one-time `code` for tokens. Throws a short, non-leaky message on
 *  failure (Google's body can echo the client secret's scopes). */
export async function exchangeCode(opts: { code: string; origin: string }): Promise<TokenExchange> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    cache: "no-store",
    body: new URLSearchParams({
      code: opts.code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(opts.origin),
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(res.status === 400 || res.status === 401 ? "oauth_exchange_rejected" : "oauth_exchange_failed");
  }
  return (await res.json()) as TokenExchange;
}

/**
 * The authorized-user token JSON the bot loads. Shape must match what
 * `google.oauth2.credentials.Credentials.from_authorized_user_file` expects:
 * token, refresh_token, token_uri, client_id, client_secret, scopes.
 */
export function buildTokenJson(tok: TokenExchange): string {
  const scopes = (tok.scope ?? YOUTUBE_OAUTH_SCOPES.join(" ")).split(/\s+/).filter(Boolean);
  return JSON.stringify({
    token: tok.access_token,
    refresh_token: tok.refresh_token ?? "",
    token_uri: TOKEN_ENDPOINT,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    scopes,
  });
}

/**
 * The GitHub Actions secret name a channel's token is sealed into. The legacy
 * default channel keeps the unsuffixed `YOUTUBE_TOKEN_JSON`; every named channel
 * uses `CHRONOS_YT_TOKEN_<REF>`, matching modules/channel_credentials.env_var_name
 * and lib/server/github-secrets.channelTokenSecret.
 */
export function tokenSecretName(ref: string): string {
  const slug = (ref || "").trim().toLowerCase();
  if (!slug || slug === "default" || slug === "all") return "YOUTUBE_TOKEN_JSON";
  return "CHRONOS_YT_TOKEN_" + slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
