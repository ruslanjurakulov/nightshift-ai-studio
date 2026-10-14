import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { publicOrigin } from "@/lib/server/public-origin";
import { SMALL_BODY_BYTES, readJsonBodyCapped } from "@/lib/server/json-body";
import { PENDING_COOKIE, dropUserPending, pendingHandleFrom } from "@/lib/server/connect-pending";
import { confirmYoutubePick } from "@/lib/server/connect-youtube";
import { confirmSocialPick } from "@/lib/server/social-connect";
import { isSocialPlatform } from "@/lib/social-accounts";
import type { ConfirmResult } from "@/lib/connect-picker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const YT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** HTTP status per answer. Nothing but our own word is ever in the body. */
const STATUS: Record<ConfirmResult, number> = {
  connected: 200,
  created_not_connected: 200,
  already_connected: 409,
  not_in_list: 400,
  expired: 410,
  forbidden: 403,
  not_configured: 503,
  unavailable: 503,
  id_taken: 409,
  busy: 409,
  failed: 502,
};

/** Answers after which the held authorisation is gone (or never will work). */
const TERMINAL: ReadonlySet<ConfirmResult> = new Set(["connected", "created_not_connected", "expired", "forbidden"]);

function answer(result: ConfirmResult, extra: Record<string, unknown> = {}) {
  const res = NextResponse.json({ ok: result === "connected" || result === "created_not_connected", result, ...extra }, { status: STATUS[result] });
  if (TERMINAL.has(result)) res.cookies.set(PENDING_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

/**
 * The pick screen's one write.
 *
 * POST `{ action: "confirm", platform, channel_id? }` or `{ action: "cancel" }`.
 *
 * The browser names only WHICH of the listed accounts it means. The
 * authorisation itself (the token, the list Google returned) is held on the
 * server under the httpOnly handle cookie, bound to this user and the
 * organization being viewed (lib/server/connect-pending.ts); the chosen id is
 * checked against that held list, and the role is checked again here — the
 * same checks the per-channel connect makes, never the state of the screen.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // A same-site fetch always sends Origin; a cross-site form post is refused
  // even though the cookies are SameSite=Lax.
  const origin = request.headers.get("origin");
  if (origin && origin !== publicOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const read = await readJsonBodyCapped(request, SMALL_BODY_BYTES);
  if (!read.ok || !read.value || typeof read.value !== "object")
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const body = read.value as { action?: unknown; platform?: unknown; channel_id?: unknown };

  if (body.action === "cancel") {
    dropUserPending(user.id);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(PENDING_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  }
  if (body.action !== "confirm") return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const handle = pendingHandleFrom(request);

  if (body.platform === "youtube") {
    const id = typeof body.channel_id === "string" ? body.channel_id.trim() : "";
    if (!YT_ID_RE.test(id)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const out = await confirmYoutubePick({ userId: user.id, handle, youtubeChannelId: id });
    return answer(out.result, out.channelId ? { channel_id: out.channelId } : {});
  }
  if (isSocialPlatform(body.platform)) {
    const out = await confirmSocialPick({ userId: user.id, handle, platform: body.platform });
    return answer(out.result);
  }
  return NextResponse.json({ error: "bad_request" }, { status: 400 });
}
