import "server-only";
import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { logAudit } from "@/lib/server/audit";
import { publicOrigin } from "@/lib/server/public-origin";
import {
  INSTAGRAM_SCOPES,
  NONCE_COOKIE,
  PKCE_COOKIE,
  SocialOAuthError,
  TIKTOK_REQUIRED_SCOPES,
  TIKTOK_SCOPES,
  buildInstagramAuthUrl,
  buildTiktokAuthUrl,
  decodeSocialState,
  encodeSocialState,
  exchangeInstagramCode,
  exchangeTiktokCode,
  fetchInstagramProfile,
  fetchTiktokProfile,
  isSocialConfigured,
  newCodeVerifier,
  newNonce,
  nonceMatches,
  readCookie,
  tiktokCodeChallenge,
  type SocialProfile,
} from "@/lib/server/social-oauth";
import { storeSocialAccount } from "@/lib/server/social-accounts";
import {
  missingSocialScopes,
  socialReturnPath,
  type SocialPlatform,
  type SocialResult,
} from "@/lib/social-accounts";

/**
 * The shared body of app/api/oauth/{instagram,tiktok}/{start,callback}.
 *
 * Who may connect: an owner, admin or EDITOR of the organization being viewed
 * (requireOrgRole — the same answer RLS gives), checked at start so nobody
 * grants the platform access for nothing, and again at the callback because
 * the state is only a claim. store_social_account checks it a third time in
 * the database.
 *
 * Every redirect goes to one fixed same-origin path carrying a known result
 * word (socialReturnPath) — nothing from the query string is echoed.
 */

const COOKIE_MAX_AGE = 600; // 10 minutes to finish the consent screen

function cookiePath(platform: SocialPlatform): string {
  return `/api/oauth/${platform}`;
}

function back(origin: string, platform: SocialPlatform, result: SocialResult): NextResponse {
  const res = NextResponse.redirect(`${origin}${socialReturnPath(platform, result)}`);
  // Spent either way: a nonce is good for one callback.
  res.cookies.set(NONCE_COOKIE[platform], "", { path: cookiePath(platform), maxAge: 0 });
  if (platform === "tiktok") res.cookies.set(PKCE_COOKIE, "", { path: cookiePath(platform), maxAge: 0 });
  return res;
}

/** The organization being viewed, if the caller is an editor+ in it. */
async function editableOrg(): Promise<{ ok: true; orgId: string } | { ok: false; result: SocialResult }> {
  const org = await getOrgContext();
  if (!org.supported || !org.current) return { ok: false, result: org.unavailable ? "unavailable" : "not_available" };
  const access = await requireOrgRole({ orgId: org.current.id }, "editor");
  if (!access.ok) {
    return { ok: false, result: access.error === "org_unavailable" ? "unavailable" : access.error === "not_found" ? "not_found" : "forbidden" };
  }
  return { ok: true, orgId: org.current.id };
}

export async function startSocialConnect(request: Request, platform: SocialPlatform): Promise<NextResponse> {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const origin = publicOrigin(request);

  const org = await editableOrg();
  if (!org.ok) return back(origin, platform, org.result);
  if (!isSocialConfigured(platform)) return back(origin, platform, "not_configured");

  const nonce = newNonce();
  const state = encodeSocialState({ org: org.orgId, nonce });
  const cookie = { httpOnly: true, secure: true, sameSite: "lax" as const, path: cookiePath(platform), maxAge: COOKIE_MAX_AGE };

  let target: string;
  let verifier: string | null = null;
  if (platform === "tiktok") {
    verifier = newCodeVerifier();
    target = buildTiktokAuthUrl({ origin, state, codeChallenge: tiktokCodeChallenge(verifier) });
  } else {
    target = buildInstagramAuthUrl({ origin, state });
  }
  const res = NextResponse.redirect(target);
  res.cookies.set(NONCE_COOKIE[platform], nonce, cookie);
  if (verifier) res.cookies.set(PKCE_COOKIE, verifier, cookie);
  return res;
}

export async function finishSocialConnect(request: Request, platform: SocialPlatform): Promise<NextResponse> {
  const url = new URL(request.url);
  // Must be the same origin the start route sent, or the exchange is refused
  // as a redirect_uri mismatch.
  const origin = publicOrigin(request);

  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // A declined consent comes back as ?error=... (both platforms).
  if (url.searchParams.get("error")) return back(origin, platform, "denied");

  const state = decodeSocialState(url.searchParams.get("state"));
  if (!state || !nonceMatches(readCookie(request, NONCE_COOKIE[platform]), state.nonce))
    return back(origin, platform, "bad_state");

  const org = await editableOrg();
  if (!org.ok) return back(origin, platform, org.result);
  // The connection belongs to the organization the flow STARTED in; if the
  // user switched organizations meanwhile, refuse rather than guess.
  if (org.orgId !== state.org) return back(origin, platform, "bad_state");
  if (!isSocialConfigured(platform)) return back(origin, platform, "not_configured");

  const code = url.searchParams.get("code") ?? "";
  if (!code || code.length > 2048) return back(origin, platform, "bad_state");

  let result: SocialResult;
  let accountId: string | null = null;
  let externalId: string | null = null;
  try {
    if (platform === "instagram") {
      const grant = await exchangeInstagramCode({ code, origin });
      if (missingSocialScopes(grant.scopes, INSTAGRAM_SCOPES).length > 0) result = "missing_scopes";
      else {
        const profile: SocialProfile = await fetchInstagramProfile(grant.accessToken);
        externalId = profile.externalId;
        ({ result, accountId } = await storeSocialAccount({
          orgId: org.orgId,
          platform,
          accessToken: grant.accessToken,
          refreshToken: null,
          profile,
          scopes: grant.scopes.filter((s) => (INSTAGRAM_SCOPES as readonly string[]).includes(s)),
          accessExpiresIn: grant.expiresIn,
          refreshExpiresIn: null,
        }));
      }
    } else {
      const verifier = readCookie(request, PKCE_COOKIE);
      if (!verifier) return back(origin, platform, "bad_state");
      const grant = await exchangeTiktokCode({ code, origin, codeVerifier: verifier });
      if (missingSocialScopes(grant.scopes, TIKTOK_REQUIRED_SCOPES).length > 0) result = "missing_scopes";
      else {
        const profile = await fetchTiktokProfile(grant.accessToken, grant.openId);
        externalId = profile.externalId;
        ({ result, accountId } = await storeSocialAccount({
          orgId: org.orgId,
          platform,
          accessToken: grant.accessToken,
          refreshToken: grant.refreshToken,
          profile,
          scopes: grant.scopes.filter((s) => (TIKTOK_SCOPES as readonly string[]).includes(s)),
          accessExpiresIn: grant.expiresIn,
          refreshExpiresIn: grant.refreshExpiresIn,
        }));
      }
    }
  } catch (e) {
    result = e instanceof SocialOAuthError ? e.reason : "failed";
  }

  // Names and ids only — never a token.
  await logAudit({
    action: result === "connected" ? `social.${platform}.connect` : `social.${platform}.connect_failed`,
    target: accountId ?? undefined,
    detail: { platform, result, org_id: org.orgId, ...(externalId ? { external_id: externalId } : {}) },
  });
  return back(origin, platform, result);
}
