import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { joinFromCookie } from "@/lib/server/friend-invites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sign-up in a project that confirms no e-mail ("Confirm email" off) signs the
 * new account in at once, so there is no confirmation link to land on
 * /auth/callback. The sign-up page calls this instead, with the new session;
 * the database still refuses an account whose e-mail is not confirmed.
 *
 * The answer is the same whatever happened: the new person is not told whether
 * they counted.
 */
export async function POST() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const supabase = await createClient();
  if (supabase) await joinFromCookie(supabase);
  return NextResponse.json({ ok: true });
}
