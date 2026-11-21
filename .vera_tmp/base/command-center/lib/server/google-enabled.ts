import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/config";
import { fetchGoogleEnabled } from "@/lib/google-signin";

/**
 * Is "Continue with Google" on, as the SERVER sees it: the page is rendered
 * with the answer, so the Google block is either there from the first paint or
 * not there at all (no layout jump when a browser-side answer arrives).
 *
 * The answer is cached for a minute (so enabling the provider shows up within a
 * minute, with no deploy) and a slow or failed request is cut off after 3 s and
 * means "hidden": the page never offers a sign-in it cannot confirm.
 */
export const GOOGLE_SETTINGS_REVALIDATE_SECONDS = 60;

export function googleEnabledOnServer(): Promise<boolean> {
  return fetchGoogleEnabled(SUPABASE_URL, SUPABASE_ANON_KEY, {
    next: { revalidate: GOOGLE_SETTINGS_REVALIDATE_SECONDS },
    signal: AbortSignal.timeout(3000),
  });
}
