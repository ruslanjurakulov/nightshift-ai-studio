"use client";

import { createClient as createStatelessClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";

/**
 * A throwaway client for checking a password (lib/account-security.ts
 * verifyCurrentPassword): nothing persisted, no refresh timer, no cookies, its
 * own storage key. Signing in with it leaves the browser's real session exactly
 * as it was. Null when Supabase is not configured.
 */
export function createReauthClient() {
  if (!isSupabaseConfigured) return null;
  return createStatelessClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "ns-reauth" },
  });
}
