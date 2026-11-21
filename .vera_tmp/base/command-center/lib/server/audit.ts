import { createClient, getUser } from "@/lib/supabase/server";

/**
 * Record a privileged action in the append-only audit trail
 * (`public.app_audit_log`, migration 0008).
 *
 * Best-effort by design: it reads the signed-in user and inserts one row via
 * the server (anon, RLS-checked) client, so a user can only log AS themselves
 * (the insert policy pins `actor_user_id = auth.uid()`). It is a no-op when
 * there is no user or no Supabase, and it NEVER throws into the caller — an
 * audit write must not turn a successful action into a failed request.
 *
 * Callers pass NAMES ONLY. `detail` must carry non-secret metadata (which
 * secret NAMES were written, a count, a channel) — never a secret value.
 */
export async function logAudit(entry: {
  action: string;
  target?: string;
  detail?: Record<string, unknown>;
  channelId?: string;
}): Promise<void> {
  try {
    const user = await getUser();
    if (!user) return;
    const supabase = await createClient();
    if (!supabase) return;

    await supabase.from("app_audit_log").insert({
      actor_user_id: user.id,
      actor_email: user.email ?? null,
      action: entry.action,
      target: entry.target ?? null,
      detail: entry.detail ?? {},
      channel_id: entry.channelId ?? null,
    });
  } catch {
    // Swallow everything: the caller's action already succeeded, and a failed
    // audit insert (missing table, RLS, network) must not surface to the user.
  }
}
