import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";
import { publicCreditRates, type CreditRates } from "@/lib/pricing";
import { parsePrices, type PriceMap } from "@/lib/credits";
import { cachedPublicRead } from "@/lib/server/public-read";

/**
 * public_video_rates()'s rows (migration 0089), read with the anon key and no session, bounded and shared
 * (lib/server/public-read.ts): one read under one key, whichever of the two shapes below a page asks for. null when
 * there is no backend, 0089 is not applied yet, or the read failed or took too long.
 */
async function readPublicVideoRows(): Promise<unknown[] | null> {
  if (!isSupabaseConfigured) return null;
  return cachedPublicRead("public_video_rates", async (signal) => {
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data, error } = await client.rpc("public_video_rates").abortSignal(signal);
    return error || !Array.isArray(data) ? null : (data as unknown[]);
  });
}

/**
 * The two credit rates a signed-out visitor may read (public_video_rates(),
 * migration 0089): credits per finished minute of video and the smallest hold
 * per run, as charged — never the margin. null when there is no backend, 0089
 * is not applied yet, the read failed or took too long, or no positive
 * per-minute rate is set: the page then says no rate is published, and never
 * shows a number it would have had to guess.
 */
export async function readPublicCreditRates(): Promise<CreditRates | null> {
  const rows = await readPublicVideoRows();
  return rows === null ? null : publicCreditRates(rows);
}

/**
 * The same two rows as a price list, unrounded and as charged (margin 0), for the quote itself: /pricing's per-plan
 * videos and plan finder price a video with estimateRunCredits() exactly as Run now does (lib/plan-finder.ts), which
 * the rounded CreditRates above cannot (they round the rate before multiplying, so a page and a quote could
 * disagree by a cent). null as above; a list
 * without a positive per-minute rate is left to the caller (lib/plan-finder.ts videoPrices reads it as unpublished).
 */
export async function readPublicVideoPrices(): Promise<PriceMap | null> {
  const rows = await readPublicVideoRows();
  return rows === null ? null : parsePrices(rows);
}
