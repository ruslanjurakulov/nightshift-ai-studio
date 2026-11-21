import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { HandleRow } from "@/lib/handles";

/**
 * The signed-in person's own handle row (RLS lets them read exactly that row,
 * migration 0096). `supported: false` when the table is not there yet — the
 * Settings page then leaves the username part out instead of showing an empty
 * form that could not save. A failed read is "supported, none": the prompt to
 * pick one is harmless, and saving is decided by the database.
 */
export async function readOwnHandle(): Promise<{ supported: boolean; row: HandleRow | null }> {
  const supabase = await createClient();
  if (!supabase) return { supported: false, row: null };
  try {
    const { data, error } = await supabase.from("user_handles").select("handle, created_at, changed_at").maybeSingle();
    if (error) {
      const missing = error.code === "42P01" || error.code === "PGRST205" || /could not find the table|does not exist/i.test(error.message ?? "");
      return { supported: !missing, row: null };
    }
    if (!data || typeof data.handle !== "string") return { supported: true, row: null };
    return { supported: true, row: { handle: data.handle, created_at: String(data.created_at), changed_at: String(data.changed_at) } };
  } catch {
    return { supported: true, row: null };
  }
}
