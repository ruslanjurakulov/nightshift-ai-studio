import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { publicOrigin } from "@/lib/server/public-origin";
import { INVITE_COOKIE_OPTIONS, peekInvite, takeVisit, visitorKey } from "@/lib/server/friend-invites";
import { INVITE_NOTICE_PATH } from "@/lib/public-paths";
import { INVITE_COOKIE, normalizeInviteToken, type InviteNotice } from "@/lib/friend-invites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * An invite link: /i/<token> (migration 0092), the page a friend's link opens.
 *
 * It never renders. Signed out, a live link puts its token in a short-lived
 * httpOnly cookie and sends the visitor to /signup, so the token is not in the
 * address bar, the history or any Referer the sign-up page's links send. The
 * auth callback reads the cookie once the new account's e-mail is confirmed
 * (lib/server/friend-invites.ts joinFromCookie); nothing is counted here.
 *
 * Every refusal is the same page: a link that is malformed, unknown, revoked,
 * used up or switched off all land on /invite?s=invalid, so the answer does not
 * say which. Signed in, the visitor already has an account, which an invite
 * cannot count: they are told so plainly (/invite?s=existing), and nothing is
 * stored. All responses carry no-referrer and no-store.
 */
function go(origin: string, path: string, notice?: InviteNotice) {
  const url = new URL(path, origin);
  if (notice) url.searchParams.set("s", notice);
  const res = NextResponse.redirect(url, 307);
  res.headers.set("referrer-policy", "no-referrer");
  res.headers.set("cache-control", "no-store");
  res.headers.set("x-robots-tag", "noindex, nofollow");
  return res;
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const origin = publicOrigin(request);
  const token = normalizeInviteToken((await params).token);

  if (!token) return go(origin, INVITE_NOTICE_PATH, "invalid");
  if (!takeVisit(visitorKey(request.headers))) return go(origin, INVITE_NOTICE_PATH, "invalid");

  const user = await getUser();
  if (user) return go(origin, INVITE_NOTICE_PATH, "existing");

  const supabase = await createClient();
  if (!supabase || !(await peekInvite(supabase, token))) return go(origin, INVITE_NOTICE_PATH, "invalid");

  const res = go(origin, "/signup");
  res.cookies.set(INVITE_COOKIE, token, INVITE_COOKIE_OPTIONS);
  return res;
}
