import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { coerceAgeState, type AgeState, type RunAgeAnswer } from "@/lib/age";

/** A missing function (0192 not applied yet), as PostgREST and Postgres report it. */
// Codes, and PostgREST's own wording naming this function, only: a broad "does not exist" match would also catch an unrelated
// failure inside the function (a missing relation) and, read as "absent", let a run on Actions go on unasked (Breach r4).
const isMissingFunction = (e: { code?: string; message?: string }) =>
  e.code === "PGRST202" || e.code === "42883" || /could not find the function public\.my_adult_attestation/i.test(e.message ?? "");

/**
 * The signed-in person's attestation (0192's my_adult_attestation, as themselves), telling a migration not yet applied ("absent")
 * from a read that failed ("unknown"): a paid run treats the two differently (lib/age.ts runAgeRefusal).
 */
export const readAgeAnswer = cache(async (): Promise<RunAgeAnswer> => {
  try {
    const supabase = await createClient();
    if (!supabase) return "unknown";
    const { data, error } = await supabase.rpc("my_adult_attestation");
    if (error) return isMissingFunction(error) ? "absent" : "unknown";
    return coerceAgeState(data);
  } catch {
    return "unknown";
  }
});

/** The same answer for the screens, where a migration not applied and a failed read both read "unknown" (never blocks anyone). */
export const readAgeState = cache(async (): Promise<AgeState> => {
  const a = await readAgeAnswer();
  return a === "absent" ? "unknown" : a;
});
