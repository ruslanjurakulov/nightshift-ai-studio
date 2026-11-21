/**
 * Supabase connection config, read from public env vars. When either is
 * missing the whole app renders a "NOT CONFIGURED" state rather than pretending
 * to have data — the Command Center never invents numbers.
 */
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
