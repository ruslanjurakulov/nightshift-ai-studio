import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";
import { hardenSessionCookie } from "@/lib/supabase/cookie-options";

/**
 * Server-side Supabase client, bound to the request cookies so it acts as the
 * logged-in user (RLS applies). Returns null when Supabase isn't configured, so
 * callers render a NOT CONFIGURED state instead of crashing.
 */
export async function createClient() {
  if (!isSupabaseConfigured) return null;
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, hardenSessionCookie(options)),
          );
        } catch {
          // Called from a Server Component where cookies are read-only — the
          // middleware refreshes the session instead, so this is safe to ignore.
        }
      },
    },
  });
}

/** The current logged-in user, or null (not configured, or not signed in). */
export async function getUser() {
  const supabase = await createClient();
  if (!supabase) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}
