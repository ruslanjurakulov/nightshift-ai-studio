import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { publicOrigin } from "@/lib/server/public-origin";
import { isUnsubscribeScope, isUnsubscribeToken } from "@/lib/email-prefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The one-click unsubscribe behind every e-mail (migration 0103): POST only.
 * A GET is refused (405), so a mail scanner that opens every link cannot turn
 * anyone's mail off.
 *
 * Two callers, told apart by the body: a mail program posting
 * `List-Unsubscribe=One-Click` (RFC 8058) gets a bare 200 or 400; the button on
 * /unsubscribe, a plain form post, is sent back to that page with `d=1` or `d=0`.
 * The token and the scope are in the query, so a form with no fields works.
 *
 * No sign-in: the token (64 random hex characters, matched in the database)
 * is the authority, and the only thing it can do is switch mail OFF. The
 * database answers 'ok' or 'invalid' and nothing else; an unknown token reads
 * exactly like a malformed one. Nothing is logged; no response carries the token.
 */
function noStore<T extends Response>(res: T): T {
  res.headers.set("cache-control", "no-store");
  res.headers.set("referrer-policy", "no-referrer");
  res.headers.set("x-robots-tag", "noindex, nofollow");
  return res;
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("t");
  const scope = url.searchParams.get("s");
  const language = /^[a-z]{2,3}$/.test(url.searchParams.get("l") ?? "") ? url.searchParams.get("l")! : "";
  let oneClick = false;
  try {
    oneClick = (await request.text()).includes("List-Unsubscribe=One-Click");
  } catch {
    oneClick = false;
  }

  let ok = false;
  if (isUnsubscribeToken(token) && isUnsubscribeScope(scope)) {
    const supabase = await createClient();
    if (supabase) {
      const { data, error } = await supabase.rpc("email_unsubscribe", { p_token: token, p_scope: scope });
      ok = !error && data === "ok";
    }
  }

  if (oneClick) return noStore(NextResponse.json({ ok }, { status: ok ? 200 : 400 }));
  const back = new URL("/unsubscribe", publicOrigin(request));
  back.searchParams.set("d", ok ? "1" : "0");
  if (isUnsubscribeScope(scope)) back.searchParams.set("s", scope);
  if (language) back.searchParams.set("l", language);
  return noStore(NextResponse.redirect(back, 303));
}
