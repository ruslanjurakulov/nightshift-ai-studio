import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { ownerAccess, PRESENT_COOKIE } from "@/lib/server/owner-analytics";

export const dynamic = "force-dynamic";

/**
 * Presentation mode on or off for this browser. A cookie, not a URL parameter: it must hold on every tab and link of the hub,
 * including one typed by hand. Owner only (anyone else has nothing to present). It changes what the hub renders and exports, not
 * what the database returns — the database never returns an e-mail or a name to the hub in the first place.
 */
export const POST = requireSameOrigin(async (request: Request) => {
  if ((await ownerAccess()) !== "owner") {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
  }
  let on = false;
  try {
    on = ((await request.json()) as { on?: unknown }).on === true;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const res = NextResponse.json({ ok: true, on }, { headers: { "cache-control": "no-store" } });
  res.cookies.set(PRESENT_COOKIE, on ? "1" : "0", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return res;
});
