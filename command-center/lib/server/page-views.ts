import "server-only";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";
import type { PageViewBeacon } from "@/lib/page-views";

/**
 * Add one to a day's total (record_page_view, migration 0101). The anon key
 * only: the function is the one thing that role may call, it validates every
 * argument against a closed list and applies a platform-wide ceiling. Nothing
 * is returned and nothing is thrown: a count that did not happen is simply a
 * count that did not happen, and must never slow or break a page.
 */
export async function recordPageView(b: PageViewBeacon): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    await client.rpc("record_page_view", { p_path: b.path, p_ref_host: b.ref, p_device: b.device, p_lang: b.lang });
  } catch {
    // see above
  }
}
