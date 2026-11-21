import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";
import { cachedPublicRead } from "@/lib/server/public-read";
import { parsePublicModels, type PublicModel } from "@/lib/public-models";

/**
 * The models on sale today, by name (migration 0193 public_models_on_sale: the very list sellable_models gives a member, names
 * and capability codes only). Read with the anon key and no session, bounded and shared like the price lists
 * (lib/server/public-read.ts). null means "draw no strip": no backend, 0193 not applied yet, the read failed or took too long,
 * or an answer we do not recognise. Never a guessed or remembered list.
 */
export async function readPublicModelsOnSale(): Promise<PublicModel[] | null> {
  if (!isSupabaseConfigured) return null;
  return cachedPublicRead("public_models_on_sale", async (signal) => {
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data, error } = await client.rpc("public_models_on_sale").abortSignal(signal);
    return error ? null : parsePublicModels(data);
  });
}
