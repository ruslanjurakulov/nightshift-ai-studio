import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { brainJson, dbRefusal } from "@/lib/server/brain/session";

/**
 * Migration 0232's film lease (supabase/migrations/0232_ai_chat_film_plan_leases.sql): one plan per FILM, its worst case of turns
 * reserved against the workspace's daily cap and the person's own limit when it begins. Taken by both routes that write a film's
 * storyboard (the film editor's /api/brain/film and the chat's `choose`, /api/brain/turn), right after 0211's per-conversation lease
 * and before the plan's first turn, so the same refusals read the same way in both.
 *
 * Before 0232 is applied the function does not exist: the plan goes on as it did before (the route-level per-person yield, the
 * read-only cap check), and `held: false` says no reservation stands behind it. Nothing here spends, starts or publishes.
 */

type Rpc = { data: unknown; error: { code?: string; message?: string; details?: string } | null };

/** The function is not there (0232 not applied): PostgREST's "no such function", or Postgres' own. */
const NOT_APPLIED = new Set(["PGRST202", "42883"]);

export type FilmLease =
  /** 0232's lease is held: `reserved` turns are this plan's, and no other plan of the film can begin until it ends or expires. */
  | { ok: true; held: true; reserved: number }
  /** 0232 is not applied: nothing is reserved and nothing ties the plan to the film (the guarantee is not claimed). */
  | { ok: true; held: false }
  | { ok: false; res: Response; reason: string };

/** plan_over_cap's detail as 0232 writes it: `left=N needed=M scope=workspace|trial|person`. */
function overCap(details: string | undefined) {
  const m = /^left=(\d+) needed=(\d+) scope=(workspace|trial|person)$/.exec(details ?? "");
  return m ? { left: Number(m[1]), scope: m[3] } : null;
}

export async function beginFilmLease(supabase: SupabaseClient, sessionId: string, filmId: string,
                                     turns: { at_most: number; about: number }): Promise<FilmLease> {
  let r: Rpc;
  try {
    r = (await supabase.rpc("ai_chat_film_plan_begin", { p_session: sessionId, p_film: filmId, p_at_most: turns.at_most })) as Rpc;
  } catch {
    // The answer was lost: the lease may or may not be held. Not planned on a guess; the lease (if any) ends with 0211's plan_end.
    return { ok: false, reason: "unavailable", res: brainJson({ error: "unavailable" }, 503) };
  }
  if (r.error) {
    if (NOT_APPLIED.has(r.error.code ?? "")) return { ok: true, held: false };
    if (r.error.message === "plan_running") {
      // Another plan of this film (another tab, a colleague, or the chat's draft) holds it: said with when it ends, nothing taken.
      return { ok: false, reason: "plan_running",
               res: brainJson({ error: "plan_running", expires_at: typeof r.error.details === "string" ? r.error.details : null }, 409) };
    }
    if (r.error.message === "plan_over_cap") {
      // Refused under the workspace's lock, so `left` is what is really left after every running plan's reservation. A detail that
      // cannot be read leaves `left` unknown (rule 5), never 0.
      const d = overCap(r.error.details);
      return { ok: false, reason: "plan_over_cap", res: brainJson({
        error: "plan_over_cap", needed: turns.at_most, about: turns.about, left: d ? d.left : null,
        ...(d?.scope === "person" ? { scope: "person" } : {}),
      }, 429) };
    }
    if (r.error.message === "film_not_found") return { ok: false, reason: "not_found", res: brainJson({ error: "not_found" }, 404) };
    const res = dbRefusal(r.error);
    const body = res ? ((await res.clone().json().catch(() => ({}))) as { error?: unknown }) : {};
    return { ok: false, reason: typeof body.error === "string" ? body.error.slice(0, 40) : "unavailable",
             res: res ?? brainJson({ error: "unavailable" }, 503) };
  }
  const d = (r.data ?? null) as { reserved?: unknown } | null;
  // An answer without its reservation is not a lease anybody can rely on: refused rather than planned without one.
  if (!d || typeof d.reserved !== "number" || !Number.isInteger(d.reserved) || d.reserved < 1) {
    return { ok: false, reason: "unavailable", res: brainJson({ error: "unavailable" }, 503) };
  }
  return { ok: true, held: true, reserved: d.reserved };
}
