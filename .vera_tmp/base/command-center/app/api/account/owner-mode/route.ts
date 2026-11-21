import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { operatorLookup } from "@/lib/auth/org-roles";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { OWNER_MODE_COOKIE } from "@/lib/owner-mode";
import { ownerAccess } from "@/lib/server/owner-analytics";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

/**
 * POST { on: boolean } — the avatar menu's account switcher (User / Owner). The role is checked HERE, on the server: only
 * the platform operator may set the preference at all (a customer is refused, and the layout ignores the cookie for them
 * anyway), and only the platform OWNER may switch to the Owner account (owner_analytics_is_owner(), the guard the Owner
 * Console uses): an admin is refused. Back to User is open to any operator. A failed lookup is not "you are a customer":
 * it answers 503 so the switcher says "try again" instead of pretending. Nothing is spent, published or read beyond the
 * caller's own role.
 */
export const POST = requireSameOrigin(async (request: Request) => {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
  }
  const on = (body as { on?: unknown } | null)?.on;
  if (typeof on !== "boolean") return NextResponse.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
  const lookup = await operatorLookup();
  if (lookup.failed) return NextResponse.json({ error: "role_unavailable" }, { status: 503, headers: NO_STORE });
  if (!lookup.operator) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  if (on) {
    const access = await ownerAccess();
    if (access === "error" || access === "missing") return NextResponse.json({ error: "role_unavailable" }, { status: 503, headers: NO_STORE });
    if (access !== "owner") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const res = NextResponse.json({ on }, { headers: NO_STORE });
  res.cookies.set(OWNER_MODE_COOKIE, on ? "on" : "off", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
});
