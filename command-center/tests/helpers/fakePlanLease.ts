/**
 * 0211's plan lease for the route tests' fake databases (supabase/migrations/0211_ai_chat_plan_leases.sql, the rules the route relies
 * on): one running plan per conversation, refused `plan_running` with when it ends; failed or expired granted again as attempt + 1;
 * only the running attempt ends it. `missing` makes the functions absent, as a database without 0211 answers.
 */
export type LeaseRpc = { data: unknown; error: { code?: string; message?: string; details?: string } | null };

export function fakePlanLease() {
  const leases = new Map<string, { attempt: number; state: "running" | "failed" | "done"; reason: string | null; expires: number }>();
  const state = { missing: false, userLeft: 300 as number | null, now: () => Date.now() };
  return {
    state,
    leases,
    reset() {
      leases.clear();
      state.missing = false;
      state.userLeft = 300;
    },
    /** The fake's answer for a 0211 function, or null when `fn` is not one. */
    rpc(fn: string, args: Record<string, unknown>): LeaseRpc | null {
      if (fn !== "ai_chat_plan_begin" && fn !== "ai_chat_plan_end" && fn !== "ai_chat_plan_state") return null;
      if (state.missing) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } };
      const sid = String(args.p_session);
      const l = leases.get(sid);
      if (fn === "ai_chat_plan_state") {
        if (!l) return { data: null, error: null };
        const expired = l.state === "running" && l.expires <= state.now();
        return { data: { attempt: l.attempt, state: expired ? "failed" : l.state, reason: expired ? "expired" : l.reason,
                         expires_at: new Date(l.expires).toISOString() }, error: null };
      }
      if (fn === "ai_chat_plan_begin") {
        if (l && l.state === "running" && l.expires > state.now()) {
          return { data: null, error: { code: "NS409", message: "plan_running", details: new Date(l.expires).toISOString() } };
        }
        const attempt = (l?.attempt ?? 0) + 1;
        const expires = state.now() + 320_000;
        leases.set(sid, { attempt, state: "running", reason: null, expires });
        return { data: { attempt, expires_at: new Date(expires).toISOString(), user_left: state.userLeft }, error: null };
      }
      if (!l || l.attempt !== args.p_attempt || l.state !== "running") return { data: null, error: { code: "NS409", message: "plan_not_current" } };
      leases.set(sid, { ...l, state: args.p_state as "failed" | "done", reason: (args.p_reason as string | null) ?? null });
      return { data: null, error: null };
    },
  };
}
