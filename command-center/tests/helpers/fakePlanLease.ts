/**
 * 0211's plan lease for the route tests' fake databases (supabase/migrations/0211_ai_chat_plan_leases.sql, the rules the route relies
 * on): one running plan per conversation, refused `plan_running` with when it ends; failed or expired granted again as attempt + 1;
 * only the running attempt ends it. `missing` makes the functions absent, as a database without 0211 answers.
 *
 * And 0232's film lease (supabase/migrations/0232_ai_chat_film_plan_leases.sql), off by default (`state.film = "missing"`: the
 * function is absent, as a database without 0232 answers, so every route test that predates it sees the behaviour it was written
 * for). With `state.film = "on"`: one running plan per FILM (`plan_running`), riding on the conversation's running 0211 attempt
 * (`plan_not_current` otherwise), its at_most reserved against `state.quota()` (`plan_over_cap`, detail `left=N needed=M
 * scope=workspace`), ended with that attempt by ai_chat_plan_end, and no longer counted once expired. The test's own
 * ai_chat_reserve_turn asks `outstanding` / `reserved` / `take` to count a plan's turn out of its reservation, as 0232's does.
 */
export type LeaseRpc = { data: unknown; error: { code?: string; message?: string; details?: string } | null };

type FilmLease = { session: string; attempt: number; reserved: number; taken: number; state: "running" | "failed" | "done"; expires: number };

export function fakePlanLease() {
  const leases = new Map<string, { attempt: number; state: "running" | "failed" | "done"; reason: string | null; expires: number }>();
  const films = new Map<string, FilmLease>();
  const state = {
    missing: false, userLeft: 300 as number | null, now: () => Date.now(),
    film: "missing" as "missing" | "on",
    /** The workspace's charged turns and cap, as the test's fake database counts them (null: no cap to reserve against). */
    quota: null as null | (() => { used: number; limit: number | null }),
  };
  const live = (l: FilmLease) => l.state === "running" && l.expires > state.now();
  const reserved = () => [...films.values()].filter(live).reduce((a, l) => a + Math.max(0, l.reserved - l.taken), 0);
  const ofSession = (sid: string) => [...films.values()].find((l) => l.session === sid && live(l));
  return {
    state,
    leases,
    films,
    reset() {
      leases.clear();
      films.clear();
      state.missing = false;
      state.userLeft = 300;
      state.film = "missing";
      state.quota = null;
    },
    /** What every running, unexpired film plan still holds (0232 ai_chat_reserved). */
    reserved,
    /** What this conversation's running film plan still holds of its reservation. */
    outstanding(sid: string) {
      const l = ofSession(sid);
      return l ? Math.max(0, l.reserved - l.taken) : 0;
    },
    /** A turn of this conversation: taken out of its film plan's reservation, if it has one running (0232's first hunk). */
    take(sid: string) {
      const l = ofSession(sid);
      if (l) l.taken += 1;
    },
    /** The fake's answer for a 0211 or 0232 function, or null when `fn` is not one. */
    rpc(fn: string, args: Record<string, unknown>): LeaseRpc | null {
      if (fn === "ai_chat_film_plan_begin") {
        if (state.missing || state.film === "missing") {
          return { data: null, error: { code: "PGRST202", message: "Could not find the function public.ai_chat_film_plan_begin" } };
        }
        const sid = String(args.p_session);
        const film = String(args.p_film);
        const atMost = Number(args.p_at_most);
        const pl = leases.get(sid);
        if (!pl || pl.state !== "running" || pl.expires <= state.now()) return { data: null, error: { code: "NS409", message: "plan_not_current" } };
        const held = films.get(film);
        if (held && live(held)) {
          if (held.session === sid && held.attempt === pl.attempt) {
            return { data: { film_id: film, attempt: held.attempt, reserved: held.reserved, taken: held.taken, left: null, scope: null }, error: null };
          }
          return { data: null, error: { code: "NS409", message: "plan_running", details: new Date(held.expires).toISOString() } };
        }
        const other = ofSession(sid);
        if (other) return { data: null, error: { code: "NS409", message: "plan_running", details: new Date(other.expires).toISOString() } };
        const q = state.quota?.() ?? null;
        const left = q && q.limit !== null ? q.limit - q.used - reserved() : null;
        if (left !== null && left < atMost) {
          return { data: null, error: { code: "NS429", message: "plan_over_cap", details: `left=${Math.max(0, left)} needed=${atMost} scope=workspace` } };
        }
        films.set(film, { session: sid, attempt: pl.attempt, reserved: atMost, taken: 0, state: "running", expires: pl.expires });
        return { data: { film_id: film, attempt: pl.attempt, reserved: atMost, taken: 0, left: left === null ? null : left - atMost, scope: "workspace",
                         expires_at: new Date(pl.expires).toISOString() }, error: null };
      }
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
      // 0232: the film plan of this attempt ends with it, and what it did not take is no longer reserved.
      for (const f of films.values()) if (f.session === sid && f.attempt === l.attempt && f.state === "running") f.state = args.p_state as "failed" | "done";
      return { data: null, error: null };
    },
  };
}
