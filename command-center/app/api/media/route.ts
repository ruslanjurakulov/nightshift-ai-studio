import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { loadMediaLibrary } from "@/lib/server/media";
import { parseMediaId } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The organization's library (migration 0038): assets, uploads not yet
 * ingested, and the storage quota — read under the caller's session, so RLS
 * returns rows of organizations they belong to and nothing else. `?org=`
 * picks one; otherwise the organization the app has open. Thumbnails and
 * previews come as short-lived signed links.
 */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const asked = new URL(request.url).searchParams.get("org");
  let org = asked === null ? null : parseMediaId(asked);
  if (asked !== null && !org) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (!org) {
    const ctx = await getOrgContext();
    org = ctx.current?.id ?? null;
  }
  if (!org) return NextResponse.json({ error: "org_required" }, { status: 400 });
  const lib = await loadMediaLibrary(org);
  if (!lib.available) return NextResponse.json({ error: "not_available", host: lib.host }, { status: 503 });
  if (lib.error) return NextResponse.json({ error: lib.error }, { status: 502 });
  return NextResponse.json({ org, ...lib });
}
