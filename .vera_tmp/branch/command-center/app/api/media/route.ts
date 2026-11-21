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
 *
 * `?folder=<uuid>` narrows the files to one folder (migration 0049; another
 * organization's folder simply holds nothing here), `?q=` to names containing
 * the text — matched on the server, so a library larger than one page is
 * searched whole. Both are ignored before 0049 / without them.
 */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const asked = params.get("org");
  let org = asked === null ? null : parseMediaId(asked);
  if (asked !== null && !org) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (!org) {
    const ctx = await getOrgContext();
    org = ctx.current?.id ?? null;
  }
  if (!org) return NextResponse.json({ error: "org_required" }, { status: 400 });
  const folderRaw = params.get("folder");
  const folder = folderRaw === null || folderRaw === "" ? null : parseMediaId(folderRaw);
  if (folderRaw !== null && folderRaw !== "" && !folder) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const query = (params.get("q") ?? "").slice(0, 400);
  const lib = await loadMediaLibrary(org, { folder, query });
  if (!lib.available) return NextResponse.json({ error: "not_available", host: lib.host }, { status: 503 });
  if (lib.error) return NextResponse.json({ error: lib.error }, { status: 502 });
  return NextResponse.json({ org, ...lib });
}
