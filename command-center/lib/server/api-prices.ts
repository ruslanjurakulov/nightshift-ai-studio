import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";
import { parseApiPrices, type ApiPriceMap } from "@/lib/api/pricing";

/**
 * The live API price list (api_prices, migration 0031), read with the anon
 * key and no session: 0031 lets anyone read it, because it is a price list.
 * null when there is no backend or the read failed — never the seeded
 * defaults, which are what a fresh database starts with, not a price anyone set.
 */
export async function readPublicApiPrices(): Promise<ApiPriceMap | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data, error } = await client.from("api_prices").select("unit,cents");
    return error ? null : parseApiPrices(data);
  } catch {
    return null;
  }
}
