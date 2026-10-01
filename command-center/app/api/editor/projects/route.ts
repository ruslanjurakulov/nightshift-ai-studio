import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { readJsonBody, resolveMediaOrg } from "@/lib/server/media-folders";
import { readEditorVideo } from "@/lib/server/editor";
import { parseMediaId } from "@/lib/media";
import {
  mapEditorError,
  newDocForAsset,
  parseTitle,
  validateTimeline,
} from "@/lib/editor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start a project from one library video: POST `{ org_id?, title, asset_id }`.
 *
 * The first document — the whole video with its own sound — is built here
 * from the video's own row (read under the caller's session, so RLS decides
 * whose files it may see), checked with the timeline rules, and stored by
 * create_editor_project(), which checks membership and that every file in it
 * is a live file of this organization. Free: nothing is priced or rendered.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body))
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const b = body as { org_id?: unknown; title?: unknown; asset_id?: unknown };
  const title = parseTitle(b.title);
  if (!title.ok)
    return NextResponse.json({ error: title.error }, { status: 400 });
  const assetId = parseMediaId(b.asset_id);
  if (!assetId)
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const { org, bad } = await resolveMediaOrg(b.org_id);
  if (bad) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (!org) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Another organization's video reads exactly like one that does not exist.
  const video = await readEditorVideo(org, assetId);
  const doc = video ? newDocForAsset(video) : null;
  if (!doc)
    return NextResponse.json({ error: "invalid_asset" }, { status: 400 });
  if (validateTimeline(doc).length)
    return NextResponse.json({ error: "invalid_doc" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase)
    return NextResponse.json({ error: "not_available" }, { status: 503 });
  const { data, error } = await supabase.rpc("create_editor_project", {
    p_org: org,
    p_title: title.value,
    p_doc: doc,
  });
  if (error) {
    const mapped = mapEditorError(error);
    return NextResponse.json(
      { error: mapped.error },
      { status: mapped.status },
    );
  }
  const id = parseMediaId(data);
  if (!id) return NextResponse.json({ error: "failed" }, { status: 502 });
  await logAudit({
    action: "editor.project_create",
    target: id,
    detail: { org },
  });
  return NextResponse.json({ id }, { status: 201 });
}
