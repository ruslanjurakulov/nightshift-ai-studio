import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { fetchPublicKey, putSecret } from "@/lib/server/github-secrets";
import {
  buildTokenJson,
  decodeState,
  exchangeCode,
  isGoogleOAuthConfigured,
  tokenSecretName,
} from "@/lib/server/google-oauth";

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

/**
 * Google's redirect lands here with a one-time `code`. Verify the CSRF nonce,
 * exchange the code for a refresh token, and seal the authorized-user token JSON
 * into the channel's GitHub Actions secret. The token is never stored anywhere
 * else, logged, or returned to the browser — the redirect back carries only a
 * status word.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;

  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isGoogleOAuthConfigured) return back(origin, "", "not_configured");

  // Google reports a declined consent as ?error=access_denied.
  if (url.searchParams.get("error")) return back(origin, "", "denied");

  const code = url.searchParams.get("code") ?? "";
  const stateRaw = url.searchParams.get("state") ?? "";
  const state = decodeState(stateRaw);
  if (!code || !state) return back(origin, "", "bad_state");

  // CSRF: the nonce in the state must match the httpOnly cookie we set at start.
  const cookieNonce = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${NONCE_COOKIE}=`))
    ?.slice(NONCE_COOKIE.length + 1);
  if (!cookieNonce || cookieNonce !== state.nonce) return back(origin, state.ref, "bad_state");

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
