import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { getOrgContext } from "@/lib/orgs-server";
import { aiChatEnv, aiChatMode, aiChatOpenFor } from "@/lib/brain/flag";
import { conversationView, type ConversationRow } from "@/lib/server/brain/conversation";
import { brainJson, channelOrg, dbRefusal, notFound } from "@/lib/server/brain/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The customer's own stored Nightshift AI conversations (0199), for the chat's history panel in the Studio.
 *   GET ?channel=<id>&before=<iso>|<uuid>  one page of this person's conversations here, newest activity first
 *   GET ?channel=<id>&session=<uuid>       one of them, as /api/brain/session/<id> draws it (step, card, BRIEF, messages)
 * "Here" is the scope the panel's own latest-conversation lookup uses (/api/brain): the channel's workspace and that channel, or the
 * open workspace and no channel. Every read is the person's own (anon key + their JWT, RLS: author and member), and the route pins
 * the workspace, the author and the channel again in the query and on each row it returns: a conversation the person wrote in
 * another workspace, or one written by anybody else, is never listed and never opened here, whatever the link says.
 * Read-only: 0199 has no function to rename or delete a conversation, so the panel offers neither.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Only the characters a Postgres timestamptz prints: the value is quoted into a PostgREST filter, so nothing else may reach it.
const STAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;
// Not exported: a route module may export only handlers and route config, or `next build` fails.
const PAGE = 30;
const TITLE_MAX = 60;

const titleOf = (...candidates: unknown[]) => {
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const t = c.replace(/\s+/g, " ").trim();
    // Code points, as the database counts them: an emoji cut in half is not a title.
    if (t) return Array.from(t).slice(0, TITLE_MAX).join("");
  }
  return "";
};

type Scope = { userId: string; orgId: string; channelId: string | null };

async function scope(request: Request): Promise<{ ok: true; supabase: NonNullable<Awaited<ReturnType<typeof createClient>>>; s: Scope } | { ok: false; res: Response }> {
  if (aiChatMode(aiChatEnv()) === "off") return { ok: false, res: notFound() };
  const user = await getUser();
  if (!user) return { ok: false, res: brainJson({ error: "unauthorized" }, 401) };
  const supabase = await createClient();
  if (!supabase) return { ok: false, res: notFound() };
  const channelId = (new URL(request.url).searchParams.get("channel") ?? "").trim() || null;
  let orgId: string | null = null;
  if (channelId) {
    const access = await requireOrgRole({ channelId }, "viewer");
    if (!access.ok) return { ok: false, res: access.status === 404 ? notFound() : brainJson({ error: access.error }, access.status) };
    const ch = await channelOrg(supabase, channelId);
    if (ch.state === "failed") return { ok: false, res: brainJson({ error: "unavailable" }, 503) };
    if (ch.state === "missing") return { ok: false, res: notFound() };
    orgId = ch.orgId;
  } else {
    const org = await getOrgContext();
    orgId = org.supported && org.current ? org.current.id : null;
  }
  if (!orgId || !aiChatOpenFor(orgId, aiChatEnv())) return { ok: false, res: notFound() };
  return { ok: true, supabase, s: { userId: user.id, orgId, channelId } };
}

/** The row is this person's, in this workspace and this channel: checked on what the database returned, not only asked of it. */
const ours = (r: Record<string, unknown>, s: Scope) =>
  r.org_id === s.orgId && r.created_by === s.userId && (r.channel_id ?? null) === s.channelId;

export async function GET(request: Request) {
  const scoped = await scope(request);
  if (!scoped.ok) return scoped.res;
  const { supabase, s } = scoped;
  const url = new URL(request.url);

  const session = url.searchParams.get("session");
  if (session !== null) {
    if (!UUID.test(session)) return brainJson({ error: "bad_request" }, 400);
    let q = supabase.from("ai_chat_sessions").select("id,org_id,channel_id,created_by,step,slots,brief,card,handoff,updated_at")
      .eq("id", session).eq("org_id", s.orgId).eq("created_by", s.userId);
    q = s.channelId ? q.eq("channel_id", s.channelId) : q.is("channel_id", null);
    const { data, error } = await q.maybeSingle();
    if (error) return dbRefusal(error) ?? brainJson({ error: "unavailable" }, 503);
    // Not here (another workspace, another channel, someone else's, or no such row): one answer for all, so the panel drops the row
    // and a guessed id learns nothing.
    if (!data || !ours(data as Record<string, unknown>, s)) return brainJson({ error: "gone" }, 404);
    const view = await conversationView(supabase, data as ConversationRow);
    if (!view.ok) return brainJson({ error: "unavailable" }, 503);
    return brainJson(view.body);
  }

  // The cursor is "<updated_at>|<id>" of the previous page's last row: paging on the timestamp alone would skip or repeat two
  // conversations touched in the same microsecond.
  const cursor = url.searchParams.get("before");
  let before: string | null = null;
  let beforeId: string | null = null;
  if (cursor !== null) {
    const bar = cursor.lastIndexOf("|");
    before = bar >= 0 ? cursor.slice(0, bar) : cursor;
    beforeId = bar >= 0 ? cursor.slice(bar + 1) : null;
    if (!STAMP.test(before) || Number.isNaN(Date.parse(before)) || (beforeId !== null && !UUID.test(beforeId))) return brainJson({ error: "bad_request" }, 400);
  }
  // The title is the plan's own (the BRIEF's, once there is one) or the person's first message; the BRIEF itself (up to 256 KB) is
  // not read for a list. The first message comes embedded, one per conversation, read as the person (RLS on the messages too); a
  // conversation with no message of the person's (a Start that was only a greeting writes none) is an empty row and is not listed.
  let q = supabase.from("ai_chat_sessions")
    .select("id,org_id,channel_id,created_by,step,updated_at,plan_title:brief->>title,ai_chat_messages!inner(content)")
    .eq("org_id", s.orgId).eq("created_by", s.userId);
  q = s.channelId ? q.eq("channel_id", s.channelId) : q.is("channel_id", null);
  if (before) q = q.or(beforeId ? `updated_at.lt."${before}",and(updated_at.eq."${before}",id.lt.${beforeId})` : `updated_at.lt."${before}"`);
  const { data, error } = await q
    .eq("ai_chat_messages.role", "user")
    .order("id", { referencedTable: "ai_chat_messages", ascending: true })
    .limit(1, { referencedTable: "ai_chat_messages" })
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(PAGE);
  if (error) return dbRefusal(error) ?? brainJson({ error: "unavailable" }, 503);
  const rows = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
  const sessions = rows
    .filter((r) => typeof r.id === "string" && typeof r.updated_at === "string" && ours(r, s))
    .map((r) => {
      const first = Array.isArray(r.ai_chat_messages) ? (r.ai_chat_messages[0] as { content?: unknown } | undefined) : undefined;
      return { id: r.id as string, title: titleOf(r.plan_title, first?.content), updated_at: r.updated_at as string, step: typeof r.step === "string" ? r.step : "asking" };
    });
  const last = rows[rows.length - 1];
  // A full page may have more behind it; a short one is the end. The cursor is the database's own values, never the browser's clock.
  return brainJson({ sessions, next_before: rows.length >= PAGE && last ? `${last.updated_at}|${last.id}` : null });
}
