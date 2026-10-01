import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { readJsonBody } from "@/lib/server/media-folders";
import { parseMediaId } from "@/lib/media";
import { mapEditorError } from "@/lib/editor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Export: POST `{ rev }` queues a render of that SAVED revision. This route
 * only writes the request (request_editor_export, under the caller's session:
 * membership, the current revision, files still live, the length and the
 * free-export limits); the media worker renders it with the ffmpeg engine and
 * puts the video in the library. It holds and charges no credits, calls no
 * provider, and publishes nothing — publishing stays behind the publish gate.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id: raw } = await params;
  const id = parseMediaId(raw);
  if (!id) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJsonBody(request);
  const rev =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { rev?: unknown }).rev
      : undefined;
  if (!Number.isInteger(rev) || (rev as number) < 1)
    return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase)
    return NextResponse.json({ error: "not_available" }, { status: 503 });
  const { data, error } = await supabase.rpc("request_editor_export", {
    p_project: id,
    p_rev: rev,
  });
  if (error) {
    const mapped = mapEditorError(error);
    return NextResponse.json(
      { error: mapped.error },
      { status: mapped.status },
    );
  }
  const exportId = parseMediaId(data);
  if (!exportId) return NextResponse.json({ error: "failed" }, { status: 502 });
  await logAudit({
    action: "editor.export_request",
    target: exportId,
    detail: { project: id, rev },
  });
  return NextResponse.json({ id: exportId, status: "queued" }, { status: 201 });
}
