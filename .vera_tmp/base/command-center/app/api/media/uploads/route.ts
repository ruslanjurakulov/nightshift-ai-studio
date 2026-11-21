import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { mediaDir, mediaStagingDir } from "@/lib/server/media";
import { cleanUploadName, mapMediaError, parseMaxDetail, parseMediaId, parseQuotaDetail } from "@/lib/media";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { parseJsonCapped } from "@/lib/server/json-body";
import { imageEditorEnabled } from "@/lib/imageEditor/flag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ask for an upload ticket (migration 0038).
 *
 * POST `{ org_id, filename, mime, bytes, project_id?, folder_id? }`. Calls request_upload()
 * as the signed-in user (anon key + session): the database checks membership
 * of that organization, the type allowlist (declared type and extension must
 * agree), the size cap, uploads in flight and the storage quota, and returns a
 * ticket. The body then goes to PUT /api/media/uploads/<ticket>.
 *
 * The filename is a label only: NUL and control characters are dropped here
 * (PostgREST refuses NUL in text) and the database keeps its last path
 * segment. No path is ever built from it.
 *
 * `folder_id` (migration 0051) is the folder open while the file was chosen;
 * absent / null means All files. The database checks it: a folder of this
 * organization (another one's reads like a made-up id) and an editor asking
 * (a viewer uploads to All files only). It is stored on the ticket and
 * re-checked when the worker registers the file, so a folder deleted
 * meanwhile sends the file to All files instead of failing it.
 *
 * Before 0051 is applied there is no six-argument request_upload: a request
 * that names a folder is then asked again without one, and the answer says
 * `folder_applied: false` so the page can say where the file really went —
 * never a silent All files.
 *
 * `parent_asset_id` (migration 0128) is the picture the file is an EDIT of (the image editor sends it, and only while its flag is on: with the
 * flag off it is ignored, not forwarded). The browser's id is never trusted: the database reads that picture itself (a live image of
 * `org_id`, the caller being a member) and stamps it on the ticket; the worker re-checks it when it registers the file. A parent that is not
 * the caller's to link (another organization's, deleted meanwhile, a made-up id) and a database without 0128 both save the file WITHOUT a link
 * (never losing the edit) and the answer says `parent_applied: false`; the same word for all of them, so it confirms nothing across
 * organizations. Every other refusal (quota, type, folder) is final, as without a parent.
 *
 * On a host without the media volumes (Vercel) no ticket is handed out: the
 * body could never be received or served here.
 */
export const POST = requireSameOrigin(async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!mediaStagingDir() || !mediaDir()) return NextResponse.json({ error: "media_unavailable" }, { status: 503 });

  let body: { org_id?: unknown; filename?: unknown; mime?: unknown; bytes?: unknown; project_id?: unknown; folder_id?: unknown; parent_asset_id?: unknown };
  try {
    body = await parseJsonCapped(request);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const org = parseMediaId(body.org_id);
  if (!org) return NextResponse.json({ error: "org_required" }, { status: 400 });
  const bytes = typeof body.bytes === "number" && Number.isSafeInteger(body.bytes) && body.bytes > 0 ? body.bytes : null;
  if (bytes === null) return NextResponse.json({ error: "bad_size" }, { status: 400 });
  const mime = typeof body.mime === "string" ? body.mime.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 100) : "";
  const projectId = body.project_id === undefined || body.project_id === null ? null : parseMediaId(body.project_id);
  if (body.project_id !== undefined && body.project_id !== null && !projectId)
    return NextResponse.json({ error: "bad_project" }, { status: 400 });
  const folderId = body.folder_id === undefined || body.folder_id === null ? null : parseMediaId(body.folder_id);
  if (body.folder_id !== undefined && body.folder_id !== null && !folderId)
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const parentId = body.parent_asset_id === undefined || body.parent_asset_id === null ? null : parseMediaId(body.parent_asset_id);
  if (body.parent_asset_id !== undefined && body.parent_asset_id !== null && !parentId)
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const filename = cleanUploadName(body.filename);

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const args = { p_org: org, p_filename: filename, p_mime: mime, p_bytes: bytes, p_project_id: projectId };
  let data: unknown = null;
  let error: { code?: string; message?: string; details?: string } | null = null;
  let parentApplied = false;
  let settled = false;
  if (parentId && imageEditorEnabled()) {
    // 0128: all seven arguments (none is defaulted). The database checks the parent; nothing here vouches for it.
    ({ data, error } = await supabase.rpc("request_upload", { ...args, p_folder_id: folderId, p_parent_asset_id: parentId }));
    const why = error ? mapMediaError(error).error : null;
    const unlinkable = why === "not_available" || why === "parent_not_found";
    // Save without the link when the link is not possible; any other answer (a ticket, or a real refusal) is final.
    settled = !unlinkable;
    parentApplied = !error;
  }
  let folderApplied = folderId !== null;
  if (!settled) {
    // No folder: exactly the five arguments every version of the database takes.
    ({ data, error } = await supabase.rpc("request_upload", folderId ? { ...args, p_folder_id: folderId } : args));
    if (error && folderId && mapMediaError(error).error === "not_available") {
      // 0051 not applied: upload to All files, and say so.
      ({ data, error } = await supabase.rpc("request_upload", args));
      folderApplied = false;
    }
  }
  if (error) {
    const mapped = mapMediaError(error);
    const extra =
      mapped.error === "quota_exceeded"
        ? { quota: parseQuotaDetail((error as { details?: string }).details) }
        : mapped.error === "too_large"
          ? { max_bytes: parseMaxDetail((error as { details?: string }).details) }
          : {};
    return NextResponse.json({ error: mapped.error, ...extra }, { status: mapped.status });
  }
  const out = (data ?? {}) as {
    ticket?: string;
    kind?: string;
    mime?: string;
    name?: string;
    max_bytes?: number;
    expires_at?: string;
    folder_id?: string | null;
    parent_asset_id?: string | null;
  };
  const ticket = parseMediaId(out.ticket);
  if (!ticket) return NextResponse.json({ error: "failed" }, { status: 502 });
  await logAudit({
    action: "media.upload_request",
    target: ticket,
    detail: { org, kind: out.kind ?? null, bytes, folder: folderApplied ? folderId : null, parent: parentApplied ? parentId : null },
  });
  return NextResponse.json({
    ok: true,
    ticket,
    upload_url: `/api/media/uploads/${ticket}`,
    kind: out.kind ?? null,
    mime: out.mime ?? null,
    name: out.name ?? filename,
    max_bytes: out.max_bytes ?? bytes,
    expires_at: out.expires_at ?? null,
    // What the ticket holds — the database's answer, not what was asked.
    folder_id: folderApplied ? (parseMediaId(out.folder_id) ?? null) : null,
    folder_applied: folderId === null ? null : folderApplied,
    // The database's answer, not what was asked; null = no parent was asked for.
    parent_asset_id: parentApplied ? (parseMediaId(out.parent_asset_id) ?? null) : null,
    parent_applied: parentId === null ? null : parentApplied,
  });
});
