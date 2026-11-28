import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readScenario, readSlots, type Scenario } from "@/lib/brain/logic";
import { withPlanTurns } from "@/lib/brain/plan";

/**
 * One stored Nightshift AI conversation (0199) as the panel draws it: the step, the open card, the BRIEF and the messages. Shared by
 * /api/brain/session/<id> (the canvas) and /api/brain/history (the chat's history panel), so a conversation opened from the history
 * is read through exactly the same rules as the one the canvas follows.
 */

export type ConversationRow = {
  id: string;
  channel_id: string | null;
  step: string;
  slots: unknown;
  brief: unknown;
  card: unknown;
  handoff: unknown;
  updated_at: string;
};

export async function conversationView(supabase: SupabaseClient, s: ConversationRow): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  // The newest 200, in order (Lens on 0199: oldest-first dropped the latest turns). A failed read is an error, never "empty".
  const m = await supabase.from("ai_chat_messages").select("id,role,content,payload,created_at").eq("session_id", s.id)
    .order("id", { ascending: false }).limit(200);
  if (m.error) return { ok: false };
  const slots = readSlots(s.slots);
  // A stored payload is data its author could have written directly: its scenarios are read through the same rules again, so a
  // forged one can neither crash the panel nor carry a price (only the server's `brief.price` ever does).
  const messages = ((m.data ?? []) as { id: number; role: string; content: string; payload: unknown; created_at: string }[]).reverse().map((row) => {
    const p = row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : null;
    // With the server's count of the messages planning each would take (never stored: a stored figure would be the author's).
    const scenarios = Array.isArray(p?.scenarios)
      ? withPlanTurns(p.scenarios.map((x) => readScenario(x, slots)).filter((x): x is Scenario => x !== null), slots.kind)
      : undefined;
    return { id: row.id, role: row.role, content: row.content, created_at: row.created_at,
             payload: p ? { scenarios, factsState: typeof p.factsState === "string" ? p.factsState : undefined } : null };
  });
  return {
    ok: true,
    body: {
      session: { id: s.id, channel_id: s.channel_id, step: s.step, slots, handoff: s.handoff, updated_at: s.updated_at },
      brief: s.brief, card: s.card, updated_at: s.updated_at, messages,
      plan: await planState(supabase, s.id),
    },
  };
}

/**
 * The storyboard plan of this conversation, as 0211's lease says (Lens M1): a tab that did not start it (a refresh, a second tab)
 * waits for a running one, shows a failed one with its reason, and reads a finished one. "unknown" when it could not be read (0211
 * not applied, a failed read): never "none", which would let a second plan begin beside a running one in the panel's eyes. The
 * database still refuses that (plan_running).
 */
async function planState(supabase: SupabaseClient, session: string) {
  const r = await supabase.rpc("ai_chat_plan_state", { p_session: session });
  if (r.error) return { state: "unknown" as const };
  const d = r.data as { state?: unknown; reason?: unknown; expires_at?: unknown; scenario_index?: unknown; proposal_id?: unknown } | null;
  if (!d || typeof d !== "object") return null;
  const state = d.state === "running" || d.state === "failed" || d.state === "done" ? d.state : "unknown";
  return {
    state,
    reason: typeof d.reason === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(d.reason) ? d.reason : null,
    expires_at: typeof d.expires_at === "string" ? d.expires_at : null,
    scenario_index: typeof d.scenario_index === "number" ? d.scenario_index : null,
    // Which proposal it planned (its assistant message's id): a failure is the panel's news only while that proposal is on screen.
    proposal_id: typeof d.proposal_id === "number" ? d.proposal_id : null,
  };
}
