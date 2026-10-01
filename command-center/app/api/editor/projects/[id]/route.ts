import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { readJsonBody } from "@/lib/server/media-folders";
import { loadEditorProject, readDocAssetKinds } from "@/lib/server/editor";
import { parseMediaId } from "@/lib/media";
import {
  MAX_DOC_BYTES,
  docAssetIds,
  docAssetProblems,
  docBytes,
  mapEditorError,
  parseTitle,
  validateTimeline,
  type TimelineDoc,
} from "@/lib/editor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One project as its organization sees it (RLS): the saved document, its
 * recent exports and fresh preview links. The editor polls this while an
 * export is rendering and asks it again when a preview link has expired.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id: raw } = await params;
  const id = parseMediaId(raw);
  if (!id) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const read = await loadEditorProject(id);
  if (read.state === "not_found")
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (read.state === "not_available")
    return NextResponse.json({ error: "not_available" }, { status: 503 });
  if (read.state === "read_failed")
    return NextResponse.json({ error: "failed" }, { status: 502 });
  const p = read.value;
  return NextResponse.json({
    id: p.id,
    title: p.title,
    rev: p.rev,
    doc: p.doc,
    exports: p.exports,
    assets: p.assets,
  });
}

/**
 * Save: PUT `{ base_rev, title?, doc }`. The document is checked here with the
 * same rules the renderer uses (times inside each clip, speed 0.5–2, text
 * length, no overlaps) before the database is asked; save_editor_project()
 * then checks membership, that every file is this organization's, and that
 * nobody saved in between (stale_revision). Free: nothing is rendered.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id: raw } = await params;
  const id = parseMediaId(raw);
  if (!id) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_DOC_BYTES * 2)
    return NextResponse.json({ error: "doc_too_large" }, { status: 413 });
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body))
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const b = body as { base_rev?: unknown; title?: unknown; doc?: unknown };
  if (!Number.isInteger(b.base_rev) || (b.base_rev as number) < 1)
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  let title: string | null = null;
  if (b.title !== undefined && b.title !== null) {
    const t = parseTitle(b.title);
    if (!t.ok) return NextResponse.json({ error: t.error }, { status: 400 });
    title = t.value;
  }
  if (b.doc === undefined)
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (docBytes(b.doc) > MAX_DOC_BYTES)
    return NextResponse.json({ error: "doc_too_large" }, { status: 413 });
  const problems = validateTimeline(b.doc);
  // The reasons are for the developer console, not a sentence for the person:
  // the editor only builds valid documents, so this is a client bug or a hand-made call.
  if (problems.length)
    return NextResponse.json(
      { error: "invalid_doc", problems: problems.slice(0, 10) },
      { status: 400 },
    );
  // Which files go on which track (a picture on the music track, a sound on
  // the picture track) — the renderer would refuse them at export, so say it
  // now. Read under the member's own session: a file they cannot read is
  // not available, exactly like a made-up id. Whose files they are is the
  // database's check below (invalid_asset).
  const doc = b.doc as TimelineDoc;
  const kinds = await readDocAssetKinds(docAssetIds(doc));
  if (kinds === null)
    return NextResponse.json({ error: "failed" }, { status: 502 });
  const fileProblems = docAssetProblems(doc, kinds);
  if (fileProblems.length) {
    const missing = docAssetIds(doc).some((x) => !(x in kinds));
    return NextResponse.json(
      {
        error: missing ? "invalid_asset" : "invalid_doc",
        problems: fileProblems.slice(0, 10),
      },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  if (!supabase)
    return NextResponse.json({ error: "not_available" }, { status: 503 });
  const { data, error } = await supabase.rpc("save_editor_project", {
    p_project: id,
    p_base_rev: b.base_rev,
    p_title: title,
    p_doc: b.doc,
  });
  if (error) {
    const mapped = mapEditorError(error);
    return NextResponse.json(
      { error: mapped.error },
      { status: mapped.status },
    );
  }
  const rev = Number(data);
  if (!Number.isInteger(rev) || rev < 1)
    return NextResponse.json({ error: "failed" }, { status: 502 });
  return NextResponse.json({ id, rev });
}

/** Delete: delete_editor_project() hides the project; exported files stay in the library. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id: raw } = await params;
  const id = parseMediaId(raw);
  if (!id) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const supabase = await createClient();
  if (!supabase)
    return NextResponse.json({ error: "not_available" }, { status: 503 });
  const { error } = await supabase.rpc("delete_editor_project", {
    p_project: id,
  });
  if (error) {
    const mapped = mapEditorError(error);
    return NextResponse.json(
      { error: mapped.error },
      { status: mapped.status },
    );
  }
  await logAudit({ action: "editor.project_delete", target: id, detail: {} });
  return NextResponse.json({ ok: true });
}
