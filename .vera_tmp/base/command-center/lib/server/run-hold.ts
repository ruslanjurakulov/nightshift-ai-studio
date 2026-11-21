import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** A Run now's credit hold as the person may read it (0020 credit_reservations, RLS: viewers of its organization). */
export type RunHold = { state: "open" | "captured" | "released"; amount: number | null; captured: number | null };

/** credit_reservations.job_id's own check (0020). */
export const CREDIT_REF = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/;

const n = (v: unknown): number | null => {
  const x = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
};

/**
 * The hold behind one run, read with the person's own session. Null when there is none to show: no ref, a row RLS does not give
 * (another workspace's hold reads exactly like a missing one), an unknown status, or a failed read. Null is "not known", never "none".
 */
export async function readRunHold(supabase: SupabaseClient, ref: string | null): Promise<RunHold | null> {
  if (!ref || !CREDIT_REF.test(ref)) return null;
  const r = await supabase.from("credit_reservations").select("status,amount,captured").eq("job_id", ref).maybeSingle();
  if (r.error || !r.data) return null;
  const row = r.data as Record<string, unknown>;
  if (row.status !== "open" && row.status !== "captured" && row.status !== "released") return null;
  return { state: row.status, amount: n(row.amount), captured: n(row.captured) };
}
