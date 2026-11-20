import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { coerceAgeState, type AgeState } from "@/lib/age";

/** The signed-in person's attestation (0199's my_adult_attestation, as themselves). Missing function or a failed read: unknown. */
export const readAgeState = cache(async (): Promise<AgeState> => {
  try {
    const supabase = await createClient();
    if (!supabase) return "unknown";
    const { data, error } = await supabase.rpc("my_adult_attestation");
    return error ? "unknown" : coerceAgeState(data);
  } catch {
    return "unknown";
  }
});
