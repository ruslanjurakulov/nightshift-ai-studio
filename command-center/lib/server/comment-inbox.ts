import "server-only";
import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { mapInboxError } from "@/lib/comment-inbox";

/**
 * The comment inbox's routes (migration 0081) all do the same thing: one
 * database function, called with the signed-in person's OWN session (the anon
 * key plus their cookie — the service key is never here), whose answer the
 * database has already authorized: who may act, the price, the idempotency
 * key, the state of the comment. Nothing in a route posts, drafts or spends
 * by itself: the worker does, from rows these functions wrote.
 */

export type InboxCall =
  | { ok: true; data: unknown }
  | { ok: false; response: NextResponse };

/** Call one of the inbox's database functions as the person; refusals become route answers. */
export async function callInbox(name: string, args: Record<string, unknown>): Promise<InboxCall> {
  const user = await getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const supabase = await createClient();
  if (!supabase) return { ok: false, response: NextResponse.json({ error: "not_configured" }, { status: 503 }) };
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    const mapped = mapInboxError(error);
    return { ok: false, response: NextResponse.json(mapped.body, { status: mapped.status }) };
  }
  return { ok: true, data };
}

/** The channel a row belongs to, read with the person's own session (RLS), for the audit line. */
export async function channelOf(table: "inbox_comments" | "reply_drafts" | "reply_posts", id: string): Promise<string | undefined> {
  try {
    const supabase = await createClient();
    if (!supabase) return undefined;
    const { data } = await supabase.from(table).select("channel_id").eq("id", id).maybeSingle();
    const channel = (data as { channel_id?: unknown } | null)?.channel_id;
    return typeof channel === "string" ? channel : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An audit line: WHICH action on WHICH row, and counts or flags — never the
 * comment's or the reply's words (an audit trail is not a place for audience
 * text; the database keeps the approved text in reply_intents).
 */
export async function auditInbox(
  action: string,
  table: "inbox_comments" | "reply_drafts" | "reply_posts",
  id: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await logAudit({ action, channelId: await channelOf(table, id), target: id, detail });
}

export async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
