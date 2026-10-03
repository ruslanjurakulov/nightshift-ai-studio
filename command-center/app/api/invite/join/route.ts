import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { joinFromCookie } from "@/lib/server/friend-invites";
import { publicOrigin } from "@/lib/server/public-origin";
import { isSameOriginPost } from "@/lib/auth-confirm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sign-up in a project that confirms no e-mail ("Confirm email" off) signs the
 * new account in at once, so there is no confirmation link to land on
 * /auth/callback. The sign-up page calls this instead, with the new session;
 * the database still refuses an account whose e-mail is not confirmed.
 *
 * The answer is the same whatever happened: the new person is not told whether
 * they counted. Only our own page may ask (Origin / Sec-Fetch-Site, the same test
 * the sign-in confirmation form uses): a request another site makes for the
 * visitor changes nothing, on top of the cookies being SameSite=Lax.
 */
export async function POST(request: Request) {
  const ours = [publicOrigin(request), new URL(request.url).origin];
  if (!isSameOriginPost(request.headers, ours)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const supabase = await createClient();
  if (supabase) await joinFromCookie(supabase);
  return NextResponse.json({ ok: true });
}
