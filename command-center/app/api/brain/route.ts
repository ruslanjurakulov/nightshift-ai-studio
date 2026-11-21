import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { getOrgContext } from "@/lib/orgs-server";
import { aiChatEnv, aiChatMode, aiChatOpenFor } from "@/lib/brain/flag";
import { readSlots } from "@/lib/brain/logic";
import { brainJson, channelOrg, chosenModelState, dbRefusal, notFound } from "@/lib/server/brain/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/brain?channel=<id> — the panel's state for a channel (or, without one, the current workspace): whether this plan has
 * Nightshift AI (`limit` null = upgrade), what is used today, whether the owner's model is up (its id is never sent: customers do
 * not pick it), and the person's latest open conversation here.
 */
export async function GET(request: Request) {
  if (aiChatMode(aiChatEnv()) === "off") return notFound();
  const user = await getUser();
  if (!user) return brainJson({ error: "unauthorized" }, 401);
  const supabase = await createClient();
  if (!supabase) return notFound();
  const channelId = (new URL(request.url).searchParams.get("channel") ?? "").trim() || null;
  let orgId: string | null = null;
  if (channelId) {
    const access = await requireOrgRole({ channelId }, "viewer");
    if (!access.ok) return access.status === 404 ? notFound() : brainJson({ error: access.error }, access.status);
    const ch = await channelOrg(supabase, channelId);
    if (ch.state === "failed") return brainJson({ error: "unavailable" }, 503);
    if (ch.state === "missing") return notFound();
    orgId = ch.orgId;
  } else {
    const org = await getOrgContext();
    orgId = org.supported && org.current ? org.current.id : null;
  }
  if (!orgId || !aiChatOpenFor(orgId, aiChatEnv())) return notFound();

  const [quota, sessions, role, admin] = await Promise.all([
    supabase.rpc("ai_chat_quota", { p_org: orgId }),
    (() => {
      let q = supabase.from("ai_chat_sessions").select("id,channel_id,step,slots,brief,card,updated_at").eq("org_id", orgId).neq("step", "created");
      q = channelId ? q.eq("channel_id", channelId) : q.is("channel_id", null);
      return q.order("updated_at", { ascending: false }).limit(1);
    })(),
    requireOrgRole({ orgId }, "editor"),
    // Run now is an admin's act: a long plan's hand-off says so to anyone else (Lens on 0198: a dead end otherwise).
    requireOrgRole({ orgId }, "admin"),
  ]);
  if (sessions.error) return dbRefusal(sessions.error) ?? brainJson({ error: "unavailable" }, 503);
  if (quota.error) return dbRefusal(quota.error) ?? brainJson({ error: "unavailable" }, 503);
  const q = quota.data as { used?: number; limit?: number | null; trial_left?: number | null; max_input_chars?: number; model?: unknown };
  const model = await chosenModelState(supabase, q.model);
  const latest = (sessions.data ?? [])[0] ?? null;
  return brainJson({
    // limit null: no Brain on this plan; trial_left then says how many of its lifetime trial messages remain (0 = the upgrade).
    plan: { used: q.used ?? null, limit: q.limit ?? null, trial_left: typeof q.trial_left === "number" ? q.trial_left : null, max_input_chars: q.max_input_chars ?? 2000 },
    model: model.ok ? model.state : "unknown",
    canEdit: role.ok,
    canRun: admin.ok,
    session: latest ? { id: latest.id, step: latest.step, slots: readSlots(latest.slots), brief: latest.brief, card: latest.card, updated_at: latest.updated_at } : null,
  });
}
