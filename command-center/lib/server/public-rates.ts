import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";
import { publicCreditRates, type CreditRates } from "@/lib/pricing";
import { cachedPublicRead } from "@/lib/server/public-read";

/**
 * The two credit rates a signed-out visitor may read (public_video_rates(),
 * migration 0089): credits per finished minute of video and the smallest hold
 * per run, as charged — never the margin. Read with the anon key and no
 * session, bounded and shared (lib/server/public-read.ts). null when there is
 * no backend, 0089 is not applied yet, the read failed or took too long, or no
 * positive per-minute rate is set: the page then says no rate is
 * published, and never shows a number it would have had to guess.
 */
export async function readPublicCreditRates(): Promise<CreditRates | null> {
  if (!isSupabaseConfigured) return null;
  return cachedPublicRead("public_video_rates", async (signal) => {
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data, error } = await client.rpc("public_video_rates").abortSignal(signal);
    return error ? null : publicCreditRates(data);
  });
}
