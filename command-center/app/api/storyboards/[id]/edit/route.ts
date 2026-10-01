import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { logAudit } from "@/lib/server/audit";
import { quoteStoryboard, readStoryboard } from "@/lib/server/storyboards";
import { isStoryboardId, mapStoryboardError, toScenes, toSceneEdits } from "@/lib/storyboardReview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Larger than any edit the database accepts (256 KiB of scenes), so the
 *  database stays the judge; small enough that nothing huge is parsed here. */
const MAX_BODY_BYTES = 300_000;

/**
 * Save an edit of a waiting storyboard (migration 0058): the whole new list
 * of scenes, in order — `{ revision, scenes: [{ src, narration, visual }] }`,
 * where `src` is the scene's number in that revision, or null for a new one.
 *
 * Spends nothing. Same right as approving (the Run now rule; requireOrgRole
 * here, save_storyboard_edits() checks it again in the database, which is the
 * guarantee), only while the storyboard waits, and only on the revision the
 * person edited: a stale one is 409 `stale_revision` and nothing is written —
 * never merged, never overwritten.
 *
 * The database rewrites the scene cards and the script the render resumes
 * from together, and measures each edited scene's length itself; the answer
 * carries the new revision, the stored scenes and the price of rendering
 * them, computed here exactly as the page and the approve route compute it
 * (quoteStoryboard, from the stored length) — never by the browser.
 *
 * The text is data: it is stored as JSON and later spoken and captioned. The
 * audit records counts only, never the words.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isStoryboardId(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "scenes_invalid" }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const revision = body.revision;
  if (!(typeof revision === "number" && Number.isInteger(revision) && revision >= 0))
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const scenes = toSceneEdits(body.scenes);
  if (!scenes) return NextResponse.json({ error: "scenes_invalid" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const read = await readStoryboard(supabase, id);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status });
  const sb = read.storyboard;

  const access = await requireOrgRole({ channelId: sb.channelId }, "admin");
  if (!access.ok) {
    const error = access.error === "not_found" ? "not_found" : access.error;
    return NextResponse.json({ error }, { status: access.status });
  }
  if (sb.status !== "ready") return NextResponse.json({ error: "storyboard_not_ready" }, { status: 409 });
  if (typeof sb.revision !== "number") return NextResponse.json({ error: "editing_unavailable" }, { status: 503 });
  if (revision !== sb.revision)
    return NextResponse.json({ error: "stale_revision", revision: sb.revision }, { status: 409 });

  const { data, error } = await supabase.rpc("save_storyboard_edits", {
    p_storyboard: id,
    p_revision: revision,
    p_scenes: scenes,
  });
  if (error) {
    const mapped = mapStoryboardError(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
  const res = (data ?? {}) as Record<string, unknown>;
  const newRevision = typeof res.revision === "number" ? res.revision : null;
  const durationS = typeof res.duration_s === "number" ? res.duration_s : null;
  if (newRevision === null || durationS === null) return NextResponse.json({ error: "approve_failed" }, { status: 502 });
  const saved = toScenes(res.scenes);

  // The price of what is stored now — the number the next Approve must carry.
  const quote = await quoteStoryboard(
    supabase,
    { channelId: sb.channelId, durationS },
    access.source === "org" ? access.orgId : null,
  );

  if (res.changed === true) {
    const kept = new Set(scenes.flatMap((s) => (s.src === null ? [] : [s.src])));
    await logAudit({
      action: "storyboard.edit",
      target: id,
      channelId: sb.channelId,
      detail: {
        revision: newRevision,
        scenes: saved.length,
        added: scenes.filter((s) => s.src === null).length,
        removed: sb.scenes.length - kept.size,
        duration_s: durationS,
      },
    });
  }
  return NextResponse.json({
    ok: true,
    changed: res.changed === true,
    revision: newRevision,
    durationS,
    scenes: saved,
    quote,
  });
}
