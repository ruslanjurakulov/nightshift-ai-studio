import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";
import { parseApiPrices, type ApiPriceMap } from "@/lib/api/pricing";
import { cachedPublicRead } from "@/lib/server/public-read";

/**
 * The live API price list (api_prices, migration 0031), read with the anon
 * key and no session: 0031 lets anyone read it, because it is a price list.
 * null when there is no backend, the read failed or it took too long
 * (lib/server/public-read.ts) — never the seeded defaults, which are what a
 * fresh database starts with, not a price anyone set.
 */
export async function readPublicApiPrices(): Promise<ApiPriceMap | null> {
  if (!isSupabaseConfigured) return null;
  return cachedPublicRead("api_prices", async (signal) => {
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data, error } = await client.from("api_prices").select("unit,cents").abortSignal(signal);
    return error ? null : parseApiPrices(data);
  });
}
