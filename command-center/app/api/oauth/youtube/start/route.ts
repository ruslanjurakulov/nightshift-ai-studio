import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getUser } from "@/lib/supabase/server";
import {
  buildAuthUrl,
  encodeState,
  isGoogleOAuthConfigured,
} from "@/lib/server/google-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NONCE_COOKIE = "yt_oauth_nonce";

/**
 * Begin the YouTube connect flow: set a CSRF nonce cookie and send the browser
 * to Google's consent screen. The channel ref rides in the signed-by-cookie
 * `state` so the callback knows which channel's secret to write.
 */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isGoogleOAuthConfigured)
    return NextResponse.json({ error: "google_oauth_not_configured" }, { status: 503 });

  const url = new URL(request.url);
  const ref = (url.searchParams.get("ref") ?? "").trim();
  const nonce = randomUUID();
  const state = encodeState({ ref, nonce });

  const res = NextResponse.redirect(buildAuthUrl({ origin: url.origin, state }));
  res.cookies.set(NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 minutes to complete the consent
  });
  return res;
}
