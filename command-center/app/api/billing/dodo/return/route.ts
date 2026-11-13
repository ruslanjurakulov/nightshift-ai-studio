import { NextResponse } from "next/server";
import { RETURN_PATH_RE, RETURN_STATUS_RE } from "@/lib/dodo";
import { publicOrigin } from "@/lib/server/public-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where Dodo's hosted checkout sends the customer back (the session's return
 * and cancel URLs, app/api/billing/dodo/checkout). Dodo appends `payment_id`
 * or `subscription_id`, `status` and the customer's `email`
 * (developer-resources/checkout-session, "Handle the return"); this keeps only
 * our flag, our item and Dodo's status word, and redirects to the Credits page
 * with nothing else, so the e-mail never reaches the page's URL, the browser
 * history, an analytics script or a Referer. (Our reverse proxy's access log
 * still sees this one request's query.) It reads nothing, changes nothing and
 * credits nothing: the webhook does that.
 *
 * The docs do not say how Dodo appends to a URL that already has a query, so a
 * value is read up to a stray "?" too. Only our own /{channel}/credits path is
 * a destination: no open redirect.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const first = (name: string) => (url.searchParams.get(name) ?? "").split("?")[0];
  const to = first("to");
  const flag = first("dodo");
  const item = first("item");
  if (!RETURN_PATH_RE.test(to) || (flag !== "return" && flag !== "cancelled") || (item !== "pack" && item !== "plan")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const glued = /[?&]status=([a-z_]+)/.exec(url.search)?.[1] ?? null;
  const status = url.searchParams.get("status") ?? glued;
  const next = new URL(to, publicOrigin(request));
  next.searchParams.set("dodo", flag);
  next.searchParams.set("item", item);
  if (status && RETURN_STATUS_RE.test(status)) next.searchParams.set("status", status);
  return NextResponse.redirect(next, { status: 303, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
