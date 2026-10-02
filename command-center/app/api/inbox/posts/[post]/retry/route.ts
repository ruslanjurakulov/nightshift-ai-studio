import { NextResponse } from "next/server";
import { auditInbox, callInbox } from "@/lib/server/comment-inbox";
import { isUuid } from "@/lib/comment-inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Try an approved reply again after it failed for a reason that may pass
 * (retry_reply_post, migration 0081): the same approved text, never a new one.
 * The worker looks at the comment's replies on YouTube first when the earlier
 * attempt may have gone out, so this cannot post it twice.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ post: string }> }) {
  const { post } = await params;
  if (!isUuid(post)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const out = await callInbox("retry_reply_post", { p_post: post });
  if (!out.ok) return out.response;
  const res = (out.data ?? {}) as { already?: boolean };
  if (!res.already) await auditInbox("inbox.reply.retry", "reply_posts", post);
  return NextResponse.json({ ok: true });
}
