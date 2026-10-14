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
  PENDING_COOKIE,
  claimPending,
  createPending,
  dropUserPending,
  finishPending,
  pendingCookieOptions,
  releasePending,
} from "@/lib/server/connect-pending";
import { CONNECT_PICK_PATH, PICK_FLAG, connectBackPath, type ConfirmResult } from "@/lib/connect-picker";
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

/** Where a refusal goes: the Channels page for the classic connect, the Add
 *  channel screen when the connect started there (`pick`). */
function back(origin: string, platform: SocialPlatform, result: SocialResult, pick = false): NextResponse {
  const to = pick && result !== "connected" ? connectBackPath(platform, result) : socialReturnPath(platform, result);
  const res = NextResponse.redirect(`${origin}${to}`);
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

  const pick = new URL(request.url).searchParams.get(PICK_FLAG) === "1";
  const org = await editableOrg();
  if (!org.ok) return back(origin, platform, org.result, pick);
  if (!isSocialConfigured(platform)) return back(origin, platform, "not_configured", pick);

  // A fresh start drops whatever this person had waiting: its token goes with it.
  if (pick) dropUserPending(user.id);

  const nonce = newNonce();
  const state = encodeSocialState({ org: org.orgId, nonce, ...(pick ? { pick: true as const } : {}) });
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

  const state = decodeSocialState(url.searchParams.get("state"));
  // Started from the Add channel screen: hold the grant for the confirm screen.
  const pick = state?.pick === true;

  // A declined consent comes back as ?error=... (both platforms).
  if (url.searchParams.get("error")) return back(origin, platform, "denied", pick);

  if (!state || !nonceMatches(readCookie(request, NONCE_COOKIE[platform]), state.nonce))
    return back(origin, platform, "bad_state", pick);

  const org = await editableOrg();
  if (!org.ok) return back(origin, platform, org.result, pick);
  // The connection belongs to the organization the flow STARTED in; if the
  // user switched organizations meanwhile, refuse rather than guess.
  if (org.orgId !== state.org) return back(origin, platform, "bad_state", pick);
  if (!isSocialConfigured(platform)) return back(origin, platform, "not_configured", pick);

  const code = url.searchParams.get("code") ?? "";
  if (!code || code.length > 2048) return back(origin, platform, "bad_state", pick);

  /** Set when the grant was held for the confirm screen instead of stored. */
  let held: string | null = null;

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
        if (pick) {
          held = createPending({
            userId: user.id,
            orgId: org.orgId,
            grant: {
              platform,
              accessToken: grant.accessToken,
              refreshToken: null,
              accessExpiresIn: grant.expiresIn,
              refreshExpiresIn: null,
              scopes: grant.scopes.filter((s) => (INSTAGRAM_SCOPES as readonly string[]).includes(s)),
              profile,
            },
          });
          result = "connected"; // placeholder: nothing is stored until the person confirms
        } else ({ result, accountId } = await storeSocialAccount({
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
      if (!verifier) return back(origin, platform, "bad_state", pick);
      const grant = await exchangeTiktokCode({ code, origin, codeVerifier: verifier });
      if (missingSocialScopes(grant.scopes, TIKTOK_REQUIRED_SCOPES).length > 0) result = "missing_scopes";
      else {
        const profile = await fetchTiktokProfile(grant.accessToken, grant.openId);
        externalId = profile.externalId;
        if (pick) {
          held = createPending({
            userId: user.id,
            orgId: org.orgId,
            grant: {
              platform,
              accessToken: grant.accessToken,
              refreshToken: grant.refreshToken,
              accessExpiresIn: grant.expiresIn,
              refreshExpiresIn: grant.refreshExpiresIn,
              scopes: grant.scopes.filter((s) => (TIKTOK_SCOPES as readonly string[]).includes(s)),
              profile,
            },
          });
          result = "connected"; // placeholder: nothing is stored until the person confirms
        } else ({ result, accountId } = await storeSocialAccount({
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

  if (held) {
    const res = NextResponse.redirect(`${origin}${CONNECT_PICK_PATH}`);
    res.cookies.set(NONCE_COOKIE[platform], "", { path: cookiePath(platform), maxAge: 0 });
    if (platform === "tiktok") res.cookies.set(PKCE_COOKIE, "", { path: cookiePath(platform), maxAge: 0 });
    res.cookies.set(PENDING_COOKIE, held, pendingCookieOptions);
    return res;
  }

  // Names and ids only — never a token.
  await logAudit({
    action: result === "connected" ? `social.${platform}.connect` : `social.${platform}.connect_failed`,
    target: accountId ?? undefined,
    detail: { platform, result, org_id: org.orgId, ...(externalId ? { external_id: externalId } : {}) },
  });
  return back(origin, platform, result, pick);
}

/**
 * The confirm: store the held Instagram / TikTok grant for the organization.
 * Editor+ of the organization being viewed (checked again here), the same as
 * the classic callback, and the database checks it a third time.
 */
export async function confirmSocialPick(opts: {
  userId: string;
  handle: string | undefined;
  /** What the screen the person pressed was showing; must be what is held. */
  platform: SocialPlatform;
}): Promise<{ result: ConfirmResult; platform: SocialPlatform | null }> {
  const org = await editableOrg();
  if (!org.ok) return { result: org.result === "unavailable" ? "unavailable" : "forbidden", platform: null };
  const claim = claimPending(opts.handle, { userId: opts.userId, orgId: org.orgId });
  if (!claim) return { result: "expired", platform: null };
  const handle = opts.handle as string;
  const grant = claim.grant;
  if (grant.platform === "youtube" || grant.platform !== opts.platform) {
    releasePending(handle);
    return { result: "expired", platform: null };
  }
  try {
    const { result, accountId } = await storeSocialAccount({
      orgId: org.orgId,
      platform: grant.platform,
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      profile: grant.profile,
      scopes: grant.scopes,
      accessExpiresIn: grant.accessExpiresIn,
      refreshExpiresIn: grant.refreshExpiresIn,
    });
    await logAudit({
      action: result === "connected" ? `social.${grant.platform}.connect` : `social.${grant.platform}.connect_failed`,
      target: accountId ?? undefined,
      detail: { platform: grant.platform, result, flow: "pick", org_id: org.orgId, external_id: grant.profile.externalId },
    });
    if (result === "connected" || result === "forbidden") finishPending(handle);
    else releasePending(handle);
    const mapped: ConfirmResult =
      result === "connected" ? "connected" : result === "forbidden" ? "forbidden" : result === "not_available" ? "unavailable" : "failed";
    return { result: mapped, platform: grant.platform };
  } catch {
    releasePending(handle);
    return { result: "failed", platform: grant.platform };
  }
}
