import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { readJsonBody, resolveMediaOrg } from "@/lib/server/media-folders";
import { mapFolderError, parseMoveInput } from "@/lib/media-folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Put files in a folder, or take them out of any (migration 0049):
 * POST `{ org_id?, folder_id: uuid | null, asset_ids: uuid[] }` (1–200).
 *
 * move_media_assets() runs as the signed-in user: it checks that they edit
 * the organization, that the folder is the organization's, and that every
 * id is a live file of ITS library — one id that is not (another
 * organization's, a deleted one, a made-up one) and nothing moves. Moving
 * changes which folder lists a file and nothing else.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await readJsonBody(request);
  const input = parseMoveInput(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  const { org, bad } = await resolveMediaOrg((body as { org_id?: unknown }).org_id);
  if (bad) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (!org) return NextResponse.json({ error: "org_required" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.rpc("move_media_assets", {
    p_org: org,
    p_folder: input.value.folderId,
    p_assets: input.value.assetIds,
  });
  if (error) {
    const mapped = mapFolderError(error);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  const moved = typeof data === "number" && Number.isSafeInteger(data) && data >= 0 ? data : null;
  if (moved === null) return NextResponse.json({ error: "failed" }, { status: 502 });
  await logAudit({
    action: "media.move",
    target: input.value.folderId ?? "none",
    detail: { org, files: input.value.assetIds.length, moved },
  });
  return NextResponse.json({ ok: true, moved, folder_id: input.value.folderId });
}
