import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { readJsonBody, resolveMediaOrg } from "@/lib/server/media-folders";
import {
  loadEditorProject,
  readDocAssetKinds,
  readEditorAsset,
} from "@/lib/server/editor";
import { parseMediaId } from "@/lib/media";
import {
  MAX_DOC_BYTES,
  appendAssetToDoc,
  docAssetIds,
  docAssetProblems,
  docBytes,
  mapEditorError,
  newDocForAnyAsset,
  parseTitle,
  validateTimeline,
  type EditorError,
} from "@/lib/editor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Another save landed between our read and our write: read again, a few times. */
const STALE_RETRIES = 3;

const PROBLEM_STATUS: Record<
  "clips_full" | "sounds_full" | "no_duration",
  number
> = {
  clips_full: 409,
  sounds_full: 409,
  no_duration: 400,
};

const fail = (error: EditorError, status: number) =>
  NextResponse.json({ error }, { status });

/**
 * "Open in editor": POST `{ asset_id, project_id? , org_id?, title? }` sends
 * one library file — a generated video, picture or sound — to the editor.
 *
 *   * with `project_id`: the file is added to that project (a video or
 *     picture at the end of the picture track, a sound under it) as a new
 *     saved revision;
 *   * without: a new project is started from the file and `title` names it.
 *
 * Whose files these are is decided three times, and the last one is the
 * database's. (1) The project is read under the caller's session, so another
 * organization's project reads as missing. (2) The file is read under the
 * caller's session AND pinned to the project's organization — someone who
 * belongs to two organizations can read both organizations' files, so
 * without that pin a file of one could be sent into the other's project.
 * (3) save_editor_project / create_editor_project check membership and that
 * every file in the document is a live file of the project's organization.
 *
 * Free: nothing is priced, rendered or published here. The send only writes a
 * document; an export is a separate, explicit press in the editor.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return fail("unauthorized", 401);
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body))
    return fail("bad_request", 400);
  const b = body as {
    asset_id?: unknown;
    project_id?: unknown;
    org_id?: unknown;
    title?: unknown;
  };
  const assetId = parseMediaId(b.asset_id);
  if (!assetId) return fail("bad_request", 400);
  const wantsProject = b.project_id !== undefined && b.project_id !== null;
  const projectId = wantsProject ? parseMediaId(b.project_id) : null;
  if (wantsProject && !projectId) return fail("bad_request", 400);

  const supabase = await createClient();
  if (!supabase) return fail("not_available", 503);

  // ── a new project ────────────────────────────────────────────────────────
  if (!projectId) {
    const title = parseTitle(b.title);
    if (!title.ok) return fail(title.error, 400);
    const { org, bad } = await resolveMediaOrg(b.org_id);
    if (bad) return fail("bad_request", 400);
    if (!org) return fail("forbidden", 403);
    // Another organization's file reads exactly like one that does not exist.
    const asset = await readEditorAsset(org, assetId);
    if (!asset) return fail("invalid_asset", 400);
    const doc = newDocForAnyAsset(asset);
    if (!doc) return fail("no_duration", 400);
    if (validateTimeline(doc).length) return fail("invalid_doc", 400);
    const { data, error } = await supabase.rpc("create_editor_project", {
      p_org: org,
      p_title: title.value,
      p_doc: doc,
    });
    if (error) {
      const mapped = mapEditorError(error);
      return fail(mapped.error, mapped.status);
    }
    const id = parseMediaId(data);
    if (!id) return fail("failed", 502);
    await logAudit({
      action: "editor.send_asset",
      target: id,
      detail: { org, asset: assetId, kind: asset.kind, created: true },
    });
    return NextResponse.json({ id, created: true }, { status: 201 });
  }

  // ── an existing project ──────────────────────────────────────────────────
  for (let attempt = 0; attempt < STALE_RETRIES; attempt += 1) {
    const read = await loadEditorProject(projectId);
    if (read.state === "not_found") return fail("not_found", 404);
    if (read.state === "not_available") return fail("not_available", 503);
    if (read.state === "read_failed") return fail("failed", 502);
    const project = read.value;
    // A client that names an organization must name the project's own.
    if (
      b.org_id !== undefined &&
      b.org_id !== null &&
      b.org_id !== "" &&
      parseMediaId(b.org_id) !== project.orgId
    )
      return fail("bad_request", 400);

    const asset = await readEditorAsset(project.orgId, assetId);
    if (!asset) return fail("invalid_asset", 400);
    const added = appendAssetToDoc(project.doc, asset);
    if (!added.ok)
      return fail(added.problem, PROBLEM_STATUS[added.problem]);
    const doc = added.doc;
    if (docBytes(doc) > MAX_DOC_BYTES) return fail("doc_too_large", 413);
    if (validateTimeline(doc).length) return fail("invalid_doc", 400);
    const kinds = await readDocAssetKinds(docAssetIds(doc));
    if (kinds === null) return fail("failed", 502);
    if (docAssetProblems(doc, kinds).length)
      return fail(
        docAssetIds(doc).some((x) => !(x in kinds))
          ? "invalid_asset"
          : "invalid_doc",
        400,
      );

    const { data, error } = await supabase.rpc("save_editor_project", {
      p_project: project.id,
      p_base_rev: project.rev,
      p_title: null,
      p_doc: doc,
    });
    if (error) {
      const mapped = mapEditorError(error);
      if (mapped.error === "stale_revision" && attempt < STALE_RETRIES - 1)
        continue;
      return fail(mapped.error, mapped.status);
    }
    const rev = Number(data);
    if (!Number.isInteger(rev) || rev < 1) return fail("failed", 502);
    await logAudit({
      action: "editor.send_asset",
      target: project.id,
      detail: {
        org: project.orgId,
        asset: assetId,
        kind: asset.kind,
        created: false,
      },
    });
    return NextResponse.json({ id: project.id, rev, created: false });
  }
  return fail("stale_revision", 409);
}
