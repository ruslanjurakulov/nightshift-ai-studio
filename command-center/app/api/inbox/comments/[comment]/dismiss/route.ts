import { NextResponse } from "next/server";
import { auditInbox, callInbox, jsonBody } from "@/lib/server/comment-inbox";
import { isUuid } from "@/lib/comment-inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Set a comment aside, or put it back: POST { dismissed: true | false }
 * (dismiss_inbox_comment, migration 0081). A comment whose reply is posted or
 * waiting to be posted cannot be put aside; a ready draft is discarded with it.
 * Free; nothing is posted.
 */
export async function POST(request: Request, { params }: { params: Promise<{ comment: string }> }) {
  const { comment } = await params;
  if (!isUuid(comment)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await jsonBody(request);
  if (!body || (body.dismissed !== undefined && typeof body.dismissed !== "boolean"))
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const dismissed = body.dismissed !== false;
  const out = await callInbox("dismiss_inbox_comment", { p_comment: comment, p_dismissed: dismissed });
  if (!out.ok) return out.response;
  const res = (out.data ?? {}) as { status?: string; already?: boolean };
  if (!res.already) await auditInbox(dismissed ? "inbox.comment.dismiss" : "inbox.comment.restore", "inbox_comments", comment);
  return NextResponse.json({ ok: true, status: res.status ?? null });
}
