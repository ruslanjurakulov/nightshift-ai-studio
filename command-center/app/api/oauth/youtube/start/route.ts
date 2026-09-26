import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getUser } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/roles";
import { requireOrgRole } from "@/lib/auth/org-roles";
import {
  buildAuthUrl,
  encodeState,
  isGoogleOAuthConfigured,
} from "@/lib/server/google-oauth";
import { resolveTokenStore } from "@/lib/server/channel-tokens";
import { publicOrigin } from "@/lib/server/public-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NONCE_COOKIE = "yt_oauth_nonce";

/**
 * Begin the YouTube connect flow: set a CSRF nonce cookie and send the browser
 * to Google's consent screen. The channel ref rides in the signed-by-cookie
 * `state` so the callback knows which channel's token it is.
 *
 * Who may start it depends on where the token will be kept (migration 0022,
 * lib/channel-tokens.ts decideTokenStore), and the callback checks again, the
 * same way — the state is never trusted for it:
 * - the operator's own channels (default organization, or no organizations
 *   yet): a GitHub Actions secret — platform owner/admin, exactly as before;
 * - a customer organization's channel: Supabase Vault — an owner/admin of
 *   THAT organization, viewing it (requireOrgRole; another org's channel is
 *   404, not 403).
 * Refused before the consent screen, so nobody grants Google access for
 * nothing.
 */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const ref = (url.searchParams.get("ref") ?? "").trim();

  const store = await resolveTokenStore(ref);
  if (store.mode === "unavailable")
    return NextResponse.json({ error: "org_unavailable" }, { status: 503 });
  if (store.mode === "vault") {
    const access = await requireOrgRole({ channelId: ref }, "admin");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  } else if (!(await requireRole("admin"))) {
    // The callback writes an Actions secret in the operator's repository — the
    // same platform owner/admin action as /api/setup/secrets.
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!isGoogleOAuthConfigured)
    return NextResponse.json({ error: "google_oauth_not_configured" }, { status: 503 });

  const nonce = randomUUID();
  const state = encodeState({ ref, nonce });

  const res = NextResponse.redirect(buildAuthUrl({ origin: publicOrigin(request), state }));
  res.cookies.set(NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 minutes to complete the consent
  });
  return res;
}
