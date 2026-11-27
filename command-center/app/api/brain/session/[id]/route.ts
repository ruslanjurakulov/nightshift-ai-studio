import { createClient, getUser } from "@/lib/supabase/server";
import { aiChatEnv, aiChatMode, aiChatOpenFor } from "@/lib/brain/flag";
import { conversationView, type ConversationRow } from "@/lib/server/brain/conversation";
import { brainJson, notFound } from "@/lib/server/brain/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/brain/session/<id> — one conversation of the signed-in person (RLS: its author only): the BRIEF the canvas draws (S6b,
 * docs/studio/NIGHTSHIFT_AI.md), the open card, the step, the handoff and the messages. Read-only. The chat panel itself opens
 * conversations through /api/brain/history, which also pins them to the open workspace.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (aiChatMode(aiChatEnv()) === "off") return notFound();
  const user = await getUser();
  if (!user) return brainJson({ error: "unauthorized" }, 401);
  const supabase = await createClient();
  if (!supabase) return notFound();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return notFound();
  const { data: s, error } = await supabase.from("ai_chat_sessions")
    .select("id,org_id,channel_id,step,slots,brief,card,handoff,updated_at").eq("id", id).maybeSingle();
  if (error) return brainJson({ error: "unavailable" }, 503);
  if (!s || !aiChatOpenFor(s.org_id, aiChatEnv())) return notFound();
  const view = await conversationView(supabase, s as ConversationRow);
  if (!view.ok) return brainJson({ error: "unavailable" }, 503);
  return brainJson(view.body);
}
