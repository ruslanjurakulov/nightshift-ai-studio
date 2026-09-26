import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { ORG_COOKIE, isMissingFunction, validateOrgName } from "@/lib/orgs";
import { ORG_COOKIE_OPTIONS } from "@/lib/orgs-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create an organization and make the caller its owner.
 *
 * The work is `create_organization()` (migration 0018), called with the
 * caller's own session through the anon key — the function makes the caller
 * owner, and nothing here can make anyone else one. On success the new org is
 * remembered as the current one, so the first thing a new sign-up sees is
 * their own (empty) workspace.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let name: string | null = null;
  try {
    const body = (await request.json()) as { name?: unknown };
    name = typeof body.name === "string" ? validateOrgName(body.name) : null;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!name) return NextResponse.json({ error: "invalid_name" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data, error } = await supabase.rpc("create_organization", { p_name: name });
  if (error) {
    if (isMissingFunction(error)) return NextResponse.json({ error: "migration_missing" }, { status: 503 });
    // 54000 is the per-account ceiling; everything else is a plain failure.
    const limit = error.code === "54000";
    return NextResponse.json({ error: limit ? "limit_reached" : "create_failed" }, { status: limit ? 409 : 500 });
  }
  if (typeof data !== "string") return NextResponse.json({ error: "create_failed" }, { status: 500 });

  const response = NextResponse.json({ id: data });
  response.cookies.set(ORG_COOKIE, data, ORG_COOKIE_OPTIONS);
  return response;
}
