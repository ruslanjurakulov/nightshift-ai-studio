import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { resolveRunBackend } from "@/lib/runBackend";
import {
  cleanPrompt,
  isIdempotencyKey,
  isSceneId,
  isSource,
  isVideoId,
  mapRegenError,
  parseQuote,
} from "@/lib/sceneRegenerate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Regenerate scene" (migration 0076) — the quote and the priced press for
 * ONE scene of a run that has not uploaded.
 *
 * GET  ?source=same|stock → the quote: computed by the database
 *      (quote_scene_regenerate) from the run's own Video IR and the price
 *      list, read with the signed-in person's own session. Free; reads only
 *      what the person may read. An unset price is "unpriced", never 0.
 *
 * POST { max_credits, idempotency_key, source, prompt } → the press. The
 *      body carries the price the person saw and one key per press; the
 *      database (request_scene_regenerate) does the rest in one transaction:
 *      who (an admin of the channel's organization), the re-quote (a higher
 *      price now is price_changed and nothing is held), the hold (= the
 *      quote), the regeneration row and its render job. The same key again
 *      returns the same job and holds nothing more.
 *
 * Nothing here renders, spends or publishes by itself: the route calls one
 * database function with the person's own session (anon key — the service
 * key is never here) and the queue worker does the work. A regeneration
 * runs only on the queue backend: there, the worker that holds the run's
 * files claims it. On Actions it is refused before anything is held.
 */

type Ctx = { params: Promise<{ id: string; scene: string }> };

export async function GET(request: Request, { params }: Ctx) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, scene } = await params;
  if (!isVideoId(id) || !isSceneId(scene)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const source = new URL(request.url).searchParams.get("source") ?? "same";
  if (!isSource(source)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.rpc("quote_scene_regenerate", {
    p_video: id,
    p_scene: scene,
    p_source: source,
  });
  if (error) {
    const mapped = mapRegenError(error);
    return NextResponse.json(mapped.body, { status: mapped.status === 403 ? 404 : mapped.status });
  }
  const quote = parseQuote(data);
  const backend = resolveRunBackend({ NIGHTSHIFT_RUN_BACKEND: process.env.NIGHTSHIFT_RUN_BACKEND });
  return NextResponse.json({ quote, queue: backend === "queue" });
}

export async function POST(request: Request, { params }: Ctx) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, scene } = await params;
  if (!isVideoId(id) || !isSceneId(scene)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const mc = body.max_credits;
  if (mc != null && !(typeof mc === "number" && Number.isFinite(mc) && mc > 0))
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const key = body.idempotency_key;
  if (!isIdempotencyKey(key)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const source = body.source ?? "same";
  if (!isSource(source)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const prompt = cleanPrompt(body.prompt);
  if (prompt === null) return NextResponse.json({ error: "invalid_prompt" }, { status: 400 });

  // The worker that holds the run's files is the queue worker. Refused here,
  // before anything is held, rather than queued for nobody to claim.
  const backend = resolveRunBackend({ NIGHTSHIFT_RUN_BACKEND: process.env.NIGHTSHIFT_RUN_BACKEND });
  if (backend !== "queue") return NextResponse.json({ error: "queue_required" }, { status: 409 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase.rpc("request_scene_regenerate", {
    p_video: id,
    p_scene: scene,
    p_prompt: prompt ?? null,
    p_source: source,
    p_max_credits: typeof mc === "number" ? mc : null,
    p_idem: key,
  });
  if (error) {
    const mapped = mapRegenError(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
  const res = (data ?? {}) as {
    id?: string;
    status?: string;
    render_job_id?: number | null;
    credits_held?: number | string | null;
    replayed?: boolean;
  };
  const held = res.credits_held == null ? null : Number(res.credits_held);
  if (!res.replayed) {
    // The video's own channel, read with the person's session, so the audit
    // row lands in the organization that was charged.
    const owner = await supabase.from("videos").select("channel_id").eq("video_id", id).maybeSingle();
    const channelId = (owner.data as { channel_id?: string } | null)?.channel_id ?? undefined;
    await logAudit({
      channelId,
      action: "scene.regenerate",
      target: id,
      detail: {
        scene_id: scene,
        source,
        prompt_edited: prompt != null,
        regeneration_id: res.id ?? null,
        ...(res.render_job_id ? { job_id: res.render_job_id } : {}),
        ...(held != null && Number.isFinite(held) ? { credits_reserved: held } : {}),
      },
    });
  }
  return NextResponse.json({
    ok: true,
    id: res.id ?? null,
    status: res.status ?? "queued",
    job_id: res.render_job_id ?? null,
    credits_reserved: held != null && Number.isFinite(held) ? held : null,
    replayed: res.replayed === true,
  });
}
