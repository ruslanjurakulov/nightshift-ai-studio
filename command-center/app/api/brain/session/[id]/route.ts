import { createClient, getUser } from "@/lib/supabase/server";
import { aiChatEnv, aiChatMode, aiChatOpenFor } from "@/lib/brain/flag";
import { readScenario, readSlots } from "@/lib/brain/logic";
import { brainJson, notFound } from "@/lib/server/brain/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/brain/session/<id> — one conversation of the signed-in person (RLS: its author only): the BRIEF the canvas draws (S6b,
 * docs/studio/NIGHTSHIFT_AI.md), the open card, the step, the handoff and the messages. Read-only.
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
  // The newest 200, in order (Lens on 0209: oldest-first dropped the latest turns). A failed read is an error, never "empty".
  const m = await supabase.from("ai_chat_messages").select("id,role,content,payload,created_at").eq("session_id", id)
    .order("id", { ascending: false }).limit(200);
  if (m.error) return brainJson({ error: "unavailable" }, 503);
  const slots = readSlots(s.slots);
  // A stored payload is data its author could have written directly: its scenarios are read through the same rules again, so a
  // forged one can neither crash the panel nor carry a price (only the server's `brief.price` ever does).
  const messages = (m.data ?? []).reverse().map((row) => {
    const p = row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : null;
    const scenarios = Array.isArray(p?.scenarios) ? p.scenarios.map((x) => readScenario(x, slots)).filter(Boolean) : undefined;
    return { id: row.id, role: row.role, content: row.content, created_at: row.created_at,
             payload: p ? { scenarios, factsState: typeof p.factsState === "string" ? p.factsState : undefined } : null };
  });
  return brainJson({
    session: { id: s.id, channel_id: s.channel_id, step: s.step, slots, handoff: s.handoff, updated_at: s.updated_at },
    brief: s.brief, card: s.card, updated_at: s.updated_at, messages,
  });
}
