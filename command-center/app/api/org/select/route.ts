import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { ORG_COOKIE, coerceOrgs } from "@/lib/orgs";
import { ORG_COOKIE_OPTIONS } from "@/lib/orgs-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Switch the organization the dashboard is looking at.
 *
 * Only remembers a choice the database agrees with: the org must be one
 * `my_organizations()` returns for this caller. The cookie is re-validated on
 * every request anyway (lib/orgs-server.ts), so this check is about answering
 * honestly — a 403 now rather than a silent fall-back on the next page.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let orgId = "";
  try {
    const body = (await request.json()) as { orgId?: unknown };
    orgId = typeof body.orgId === "string" ? body.orgId : "";
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!orgId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data, error } = await supabase.rpc("my_organizations");
  if (error) return NextResponse.json({ error: "migration_missing" }, { status: 503 });
  if (!coerceOrgs(data).some((o) => o.id === orgId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(ORG_COOKIE, orgId, ORG_COOKIE_OPTIONS);
  return response;
}
