import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { ORG_COOKIE, coerceOrgs } from "@/lib/orgs";
import { ORG_COOKIE_OPTIONS, switchableFor } from "@/lib/orgs-server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { parseJsonCapped } from "@/lib/server/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Switch the organization the dashboard is looking at.
 *
 * Only remembers a choice the database agrees with: the org must be one
 * `my_organizations()` returns for this caller AND one the switcher offers
 * them (switchableFor: for a platform admin, their own memberships plus the
 * default org — never a customer's workspace). The cookie is re-validated on
 * every request anyway (lib/orgs-server.ts), so this check is about answering
 * honestly — a 403 now rather than a silent fall-back on the next page.
 */
export const POST = requireSameOrigin(async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let orgId = "";
  try {
    const body = (await parseJsonCapped(request)) as { orgId?: unknown };
    orgId = typeof body.orgId === "string" ? body.orgId : "";
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!orgId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data, error } = await supabase.rpc("my_organizations");
  if (error) return NextResponse.json({ error: "migration_missing" }, { status: 503 });
  // The switcher's list, not every org the caller can read: a platform admin may read every customer's workspace
  // but is not put inside one (lib/orgs.ts switchableOrgs). The cookie would be ignored on the next request anyway;
  // refusing here is the honest answer now.
  if (!(await switchableFor(supabase, user.id, coerceOrgs(data))).some((o) => o.id === orgId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(ORG_COOKIE, orgId, ORG_COOKIE_OPTIONS);
  return response;
});
