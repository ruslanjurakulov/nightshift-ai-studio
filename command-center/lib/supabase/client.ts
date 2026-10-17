"use client";

import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";
import { browserCookieStorage } from "@/lib/supabase/cookie-options";

/**
 * Browser Supabase client for client components (auth actions, Realtime
 * subscriptions). Returns null when not configured so the UI can degrade.
 */
export function createClient() {
  if (!isSupabaseConfigured) return null;
  // The library's own document.cookie storage, with the session cookie hardened on every write (cookie-options.ts).
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, { cookies: browserCookieStorage() });
}
