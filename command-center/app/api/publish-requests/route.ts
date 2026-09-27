import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { logAudit } from "@/lib/server/audit";
import { CHANNEL_ID_RE, PUBLISH_REQUEST_COLUMNS, coercePublishRequests, type PublishRequestRow } from "@/lib/publish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TARGETS = 10;

/**
 * "Publish to platforms" → Send (migration 0029).
 *
 * POST `{ video_id, account_ids: [...], channel_ids: [...] }`. Writes one
 * publish_requests row per Instagram / TikTok account and per YouTube channel,
 * and stops — nothing here uploads, publishes or spends (CLAUDE.md #3). The
 * queue worker carries each row out after checking the publish gate and
 * approvals again; a YouTube upload is always private.
 *
 * Checks, in order: signed in; the video is visible to the caller (RLS) and in
 * the organization being viewed; the caller is an editor+ there
 * (requireOrgRole). The insert goes through the caller's own RLS-checked
 * client: the table only lets a browser name the video and ONE target (an
 * account or a channel), and its trigger fills the rest from the database —
 * the target's organization and platform, the requester — and records the row
 * REFUSED, with a reason, when the video has not passed the gate and
 * approvals, the channel is the video's own (already_on_channel), or the
 * target is not connected. One row per target, inserted one at a time, so each
 * target gets its own answer.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { video_id?: unknown; account_ids?: unknown; channel_ids?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const videoId = typeof body.video_id === "string" ? body.video_id.trim() : "";
  if (!videoId || videoId.length > 128) return NextResponse.json({ error: "video_required" }, { status: 400 });
  const accountIds = Array.isArray(body.account_ids)
    ? [...new Set(body.account_ids.filter((a): a is string => typeof a === "string" && UUID_RE.test(a)))]
    : [];
  const channelIds = Array.isArray(body.channel_ids)
    ? [...new Set(body.channel_ids.filter((c): c is string => typeof c === "string" && CHANNEL_ID_RE.test(c)))]
    : [];
  if (accountIds.length + channelIds.length === 0)
    return NextResponse.json({ error: "accounts_required" }, { status: 400 });
  if (accountIds.length + channelIds.length > MAX_TARGETS)
    return NextResponse.json({ error: "too_many_accounts" }, { status: 400 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: video } = await supabase.from("videos").select("video_id, channel_id").eq("video_id", videoId).maybeSingle();
  const channelId = (video as { channel_id?: string } | null)?.channel_id;
  if (!channelId) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const access = await requireOrgRole({ channelId }, "editor");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const rows: PublishRequestRow[] = [];
  const errors: { account_id?: string; channel_id?: string; error: string }[] = [];
  const targets: ({ account_id: string } | { target_channel_id: string })[] = [
    ...accountIds.map((id) => ({ account_id: id })),
    ...channelIds.map((id) => ({ target_channel_id: id })),
  ];
  for (const target of targets) {
    const { data, error } = await supabase
      .from("publish_requests")
      .insert({ video_id: videoId, ...target })
      .select(PUBLISH_REQUEST_COLUMNS)
      .single();
    if (error) {
      const word =
        error.code === "23505"
          ? "already_sending"
          : error.code === "42501"
            ? "forbidden"
            : error.code === "42P01" || /PGRST205|does not exist/i.test(error.message ?? "")
              ? "not_available"
              : "failed";
      errors.push(
        "account_id" in target
          ? { account_id: target.account_id, error: word }
          : { channel_id: target.target_channel_id, error: word },
      );
      continue;
    }
    rows.push(...coercePublishRequests([data]));
  }

  await logAudit({
    action: "video.publish_request",
    channelId,
    target: videoId,
    detail: {
      requests: rows.map((r) => ({
        id: r.id,
        platform: r.platform,
        account_id: r.account_id,
        target_channel_id: r.target_channel_id,
        status: r.status,
        reason: r.reason,
      })),
      ...(errors.length ? { errors } : {}),
    },
  });

  const status = rows.length ? 200 : errors.every((e) => e.error === "not_available") ? 503 : 409;
  return NextResponse.json({ ok: rows.length > 0, requests: rows, errors }, { status });
}
