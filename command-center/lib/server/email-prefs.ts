import type { SupabaseClient } from "@supabase/supabase-js";
import { parseEmailPrefs, type EmailPrefs } from "@/lib/email-prefs";

export type EmailSettings =
  | { available: false }
  | { available: true; prefs: EmailPrefs };

/**
 * What the Settings page needs to draw the e-mail switches: shown only when the
 * database has migration 0101 AND the e-mail worker is reporting to it. A
 * deployment where nothing sends mail shows no switch (a control for a promise
 * nobody keeps), and a failed read shows none either: the page never guesses a
 * saved value.
 */
export async function readEmailSettings(supabase: SupabaseClient): Promise<EmailSettings> {
  try {
    const online = await supabase.rpc("email_worker_online");
    if (online.error || online.data !== true) return { available: false };
    const got = await supabase.rpc("email_prefs_get");
    const prefs = got.error ? null : parseEmailPrefs(got.data);
    return prefs ? { available: true, prefs } : { available: false };
  } catch {
    return { available: false };
  }
}
