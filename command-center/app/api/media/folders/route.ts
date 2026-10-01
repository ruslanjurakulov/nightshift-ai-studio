import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { loadMediaFolders, readJsonBody, resolveMediaOrg } from "@/lib/server/media-folders";
import { parseMediaId } from "@/lib/media";
import { mapFolderError, parseFolderName } from "@/lib/media-folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The organization's library folders (migration 0049) with how many files
 * each holds, read under the caller's session: RLS returns folders of
 * organizations they belong to and nothing else. `?org=` picks one;
 * otherwise the organization the app has open.
 */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { org, bad } = await resolveMediaOrg(new URL(request.url).searchParams.get("org"));
  if (bad) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (!org) return NextResponse.json({ error: "org_required" }, { status: 400 });
  const state = await loadMediaFolders(org);
  if (!state.available) return NextResponse.json({ error: "not_available" }, { status: 503 });
  if (state.error) return NextResponse.json({ error: "read_failed" }, { status: 502 });
  return NextResponse.json({ org, folders: state.folders, total: state.total, unfiled: state.unfiled });
}

/**
 * Create a folder: POST `{ org_id?, name }`. save_media_folder() runs as the
 * signed-in user and checks that they edit this organization, the name
 * (1–60 characters, unique ignoring case) and the 200-folder cap.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const name = parseFolderName((body as { name?: unknown }).name);
  if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 });
  const { org, bad } = await resolveMediaOrg((body as { org_id?: unknown }).org_id);
  if (bad) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (!org) return NextResponse.json({ error: "org_required" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.rpc("save_media_folder", { p_org: org, p_folder: null, p_name: name.value });
  if (error) {
    const mapped = mapFolderError(error);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  const id = parseMediaId(data);
  if (!id) return NextResponse.json({ error: "failed" }, { status: 502 });
  await logAudit({ action: "media.folder_create", target: id, detail: { org } });
  return NextResponse.json({ id, name: name.value }, { status: 201 });
}
