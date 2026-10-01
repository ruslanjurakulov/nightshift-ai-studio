import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { readJsonBody } from "@/lib/server/media-folders";
import { parseMediaId } from "@/lib/media";
import { mapFolderError, parseFolderName } from "@/lib/media-folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rename a folder: PATCH `{ name }`. save_media_folder() takes the
 * organization from the folder itself and checks that the caller edits it;
 * another organization's folder reads as not found (404).
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id: raw } = await params;
  const id = parseMediaId(raw);
  if (!id) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const name = parseFolderName((body as { name?: unknown }).name);
  if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.rpc("save_media_folder", { p_org: null, p_folder: id, p_name: name.value });
  if (error) {
    const mapped = mapFolderError(error);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  if (parseMediaId(data) !== id) return NextResponse.json({ error: "failed" }, { status: 502 });
  await logAudit({ action: "media.folder_rename", target: id, detail: {} });
  return NextResponse.json({ id, name: name.value });
}

/**
 * Delete a folder: delete_media_folder() under the caller's session (an
 * editor of its organization). Its files are not deleted — they go back to
 * "All files" in the same transaction.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id: raw } = await params;
  const id = parseMediaId(raw);
  if (!id) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.rpc("delete_media_folder", { p_org: null, p_folder: id });
  if (error) {
    const mapped = mapFolderError(error);
    return NextResponse.json({ error: mapped.error }, { status: mapped.status });
  }
  if (data !== true) return NextResponse.json({ error: "failed" }, { status: 502 });
  await logAudit({ action: "media.folder_delete", target: id, detail: {} });
  return NextResponse.json({ ok: true });
}
