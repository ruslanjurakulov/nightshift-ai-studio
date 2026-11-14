import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";
import { parsePublicStats, shownPublicStats, type PublicStats } from "@/lib/public-stats";
import { cachedPublicRead } from "@/lib/server/public-read";

/**
 * How long one answer of public_site_stats() is kept in this server's memory. The switch is a database row, so turning the
 * counters on or off reaches the site within this window with no redeploy (docs/PUBLIC_STATS.md). The database keeps its own
 * five-minute snapshot, so a number on the page is at most about ten minutes old, and its "as of" says when it was measured.
 */
export const PUBLIC_STATS_TTL_MS = 5 * 60_000;

/**
 * The site's live counters (migration 0164), read with the anon key and no session, bounded and shared
 * (lib/server/public-read.ts). null means "show nothing": no backend, the switch is off, 0164 is not applied yet (the
 * function is missing), the read failed or took too long, or the answer is not one we know. A hidden answer is kept as long
 * as a good one, so the hidden site costs one tiny read per five minutes; a failure only as long as a failure.
 */
export async function readPublicSiteStats(): Promise<PublicStats | null> {
  if (!isSupabaseConfigured) return null;
  const read = await cachedPublicRead(
    "public_site_stats",
    async (signal) => {
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      const { data, error } = await client.rpc("public_site_stats").abortSignal(signal);
      return error ? null : parsePublicStats(data);
    },
    undefined,
    PUBLIC_STATS_TTL_MS,
  );
  return shownPublicStats(read);
}
