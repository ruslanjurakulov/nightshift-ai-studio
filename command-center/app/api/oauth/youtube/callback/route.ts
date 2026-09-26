import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/roles";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { logAudit } from "@/lib/server/audit";
import { fetchPublicKey, putSecret } from "@/lib/server/github-secrets";
import {
  YOUTUBE_OAUTH_SCOPES,
  buildTokenJson,
  decodeState,
  exchangeCode,
  isGoogleOAuthConfigured,
  tokenSecretName,
} from "@/lib/server/google-oauth";
import { fetchGrantedChannel, resolveTokenStore, storeVaultToken } from "@/lib/server/channel-tokens";
import { missingScopes, type VaultResult } from "@/lib/channel-tokens";
import { publicOrigin } from "@/lib/server/public-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NONCE_COOKIE = "yt_oauth_nonce";

/** Where to send the browser back to, with a status the Providers board reads. */
function back(origin: string, ref: string, status: string) {
  const slug = ref && ref.trim() ? ref.trim() : "default";
  const res = NextResponse.redirect(`${origin}/${slug}/providers?yt=${status}`);
  res.cookies.set(NONCE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

/** A customer channel's connection is shown on the Channels page, which lists
 *  every channel of the organization — so it needs no channel slug. */
function backToChannels(origin: string, status: VaultResult) {
  const res = NextResponse.redirect(`${origin}/all-channels/channels?yt=${status}`);
  res.cookies.set(NONCE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

function readNonceCookie(request: Request): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${NONCE_COOKIE}=`))
    ?.slice(NONCE_COOKIE.length + 1);
}

/**
 * Google's redirect lands here with a one-time `code`. Verify the CSRF nonce,
 * exchange the code for a refresh token, and store it where the channel's
 * token belongs (lib/channel-tokens.ts decideTokenStore — recomputed here from
 * the database, never taken from the state):
 *
 * - the operator's own channels: sealed into the channel's GitHub Actions
 *   secret, platform owner/admin only — this path is unchanged;
 * - a customer organization's channel: store_channel_token (migration 0022)
 *   seals it into Supabase Vault, called as the signed-in organization admin.
 *   The app holds no service key; the database checks the role again, and
 *   refuses a token granted for a different YouTube channel than the one the
 *   channel was verified against.
 *
 * The token is never stored anywhere else, logged, or returned to the browser —
 * the redirect back carries only a status word.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  // Must be the same origin the start route sent Google, or the token exchange
  // is rejected as a redirect_uri mismatch.
  const origin = publicOrigin(request);

  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const stateRaw = url.searchParams.get("state") ?? "";
  const state = decodeState(stateRaw);
  const store = state ? await resolveTokenStore(state.ref) : ({ mode: "github" } as const);

  if (store.mode === "unavailable") return backToChannels(origin, "unavailable");
  if (store.mode === "vault") {
    // Viewing the channel's organization, as its owner/admin — the same check
    // as the start route, made again because the state is only a claim.
    const access = await requireOrgRole({ channelId: state?.ref }, "admin");
    if (!access.ok) return backToChannels(origin, access.error === "not_found" ? "not_found" : "forbidden");
  } else if (!(await requireRole("admin"))) {
    // Writing a channel's upload token into the operator's repository secrets is
    // a platform owner/admin action (as /api/setup/secrets). Without this, any
    // signed-in account — a customer organization's viewer included — could
    // replace the token another channel uploads with.
    return back(origin, "", "forbidden");
  }
  if (!isGoogleOAuthConfigured)
    return store.mode === "vault" ? backToChannels(origin, "not_configured") : back(origin, "", "not_configured");

  // Google reports a declined consent as ?error=access_denied.
  if (url.searchParams.get("error"))
    return store.mode === "vault" ? backToChannels(origin, "denied") : back(origin, "", "denied");

  const code = url.searchParams.get("code") ?? "";
  if (!code || !state) return back(origin, "", "bad_state");

  // CSRF: the nonce in the state must match the httpOnly cookie we set at start.
  const cookieNonce = readNonceCookie(request);
  if (!cookieNonce || cookieNonce !== state.nonce)
    return store.mode === "vault" ? backToChannels(origin, "bad_state") : back(origin, state.ref, "bad_state");

  if (store.mode === "vault") return connectVault(origin, state.ref, code);

  const name = tokenSecretName(state.ref);

  try {
    const tok = await exchangeCode({ code, origin });
    // No refresh token = the bot can't renew access; treat as a failure so the
    // operator re-consents (access_type=offline + prompt=consent should always
    // return one, but a prior grant without revoke can suppress it).
    if (!tok.refresh_token) return back(origin, state.ref, "no_refresh");

    const key = await fetchPublicKey();
    await putSecret(name, buildTokenJson(tok), key);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "";
    const status =
      reason === "github_unauthorized"
        ? "github_unauthorized"
        : reason === "oauth_exchange_rejected"
          ? "exchange_rejected"
          : "failed";
    return back(origin, state.ref, status);
  }

  return back(origin, state.ref, "connected");
}

/**
 * The customer-channel half: exchange, check what Google granted, and hand the
 * refresh token to store_channel_token. Nothing is stored unless every check
 * passes; the access token is used once, for the channel lookup, and dropped.
 */
async function connectVault(origin: string, channelId: string, code: string) {
  let result: VaultResult;
  let youtubeId: string | null = null;
  try {
    const tok = await exchangeCode({ code, origin });
    const granted = (tok.scope ?? "").split(/\s+/).filter(Boolean);
    if (!tok.refresh_token) result = "no_refresh";
    // Google's consent screen lets a scope be unticked; the pipeline would then
    // fail at the step that needed it, after spending. Refuse now.
    else if (missingScopes(granted, YOUTUBE_OAUTH_SCOPES).length > 0) result = "missing_scopes";
    else {
      const youtube = await fetchGrantedChannel(tok.access_token);
      if (!youtube) result = "no_channel";
      else {
        youtubeId = youtube.id;
        result = await storeVaultToken({ channelId, refreshToken: tok.refresh_token, grantedScopes: granted, youtube });
      }
    }
  } catch (e) {
    result = e instanceof Error && e.message === "oauth_exchange_rejected" ? "exchange_rejected" : "failed";
  }
  // Names only: which channel, which YouTube channel, which store — never a token.
  await logAudit({
    action: result === "connected" ? "channel.youtube.connect" : "channel.youtube.connect_failed",
    channelId,
    detail: { store: "vault", result, ...(youtubeId ? { youtube_channel_id: youtubeId } : {}) },
  });
  return backToChannels(origin, result);
}
