import { normalizeAal } from "@/lib/security/aal";
import type { AdminMfaMode } from "@/lib/security/admin-mfa";

/**
 * "Recent second factor" step-up for the few admin writes that can redirect
 * alerts or the pipeline's credentials (the GitHub secret and variable routes;
 * docs/security/ADMIN_MFA.md, "Recent-MFA step-up").
 *
 * Pure and client-safe. Supabase puts the sign-in methods of a session into the
 * access token's `amr` claim, each with a unix-seconds timestamp; a TOTP entry's
 * timestamp is when the code was last typed (a token refresh keeps it). A
 * stolen aal2 cookie is therefore worth only as much as the time since that code.
 *
 * LOCKOUT SAFETY, same rule as the rest of the gate:
 *   - only `enforce` ever asks; `warn` and `off` never do;
 *   - only an `aal2` session is judged (a password-only session with a factor is
 *     already sent to the code page; an account with no factor has no code to ask);
 *   - a timestamp that cannot be read means "do not ask";
 *   - the way out is always available: sign out, sign in, type the code (that is a
 *     fresh timestamp). The owner is never locked out of the ACCOUNT by this,
 *     only asked to prove the code again before a credential write.
 */

export const RECENT_MFA_ENV = "NIGHTSHIFT_ADMIN_MFA_RECENT_MINUTES";
export const DEFAULT_RECENT_MFA_MINUTES = 480;
const MIN_MINUTES = 5;
const MAX_MINUTES = 24 * 60;

/** The window in minutes; unset, empty or unreadable is the default; clamped to 5 minutes .. 24 hours. */
export function parseRecentMfaMinutes(raw: string | null | undefined): number {
  const n = Number((raw ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RECENT_MFA_MINUTES;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.floor(n)));
}

export interface AmrEntry {
  method?: string | null;
  timestamp?: number | null;
}

/** When the session's second factor was last typed, in ms since the epoch; null = unreadable or never. */
export function lastSecondFactorAtMs(methods: ReadonlyArray<AmrEntry> | null | undefined): number | null {
  let best: number | null = null;
  for (const m of methods ?? []) {
    if (m?.method !== "totp") continue;
    const ts = Number(m.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const ms = ts * 1000;
    if (best === null || ms > best) best = ms;
  }
  return best;
}

export interface RecentMfaInput {
  mode: AdminMfaMode;
  aal: string | null | undefined;
  /** From lastSecondFactorAtMs(). */
  lastFactorAt: number | null;
  now: number;
  windowMinutes: number;
}

/**
 * | mode          | aal2, code typed within the window | aal2, older | aal2, time unreadable | aal1 / unknown |
 * |---------------|-------------------------------------|-------------|----------------------|----------------|
 * | off, warn     | ok                                  | ok          | ok                   | ok             |
 * | enforce       | ok                                  | stale       | ok                   | ok (other layers) |
 */
export function recentMfaDecision({ mode, aal, lastFactorAt, now, windowMinutes }: RecentMfaInput): "ok" | "stale" {
  if (mode !== "enforce") return "ok";
  if (normalizeAal(aal) !== "aal2") return "ok";
  if (lastFactorAt === null) return "ok";
  return now - lastFactorAt > windowMinutes * 60_000 ? "stale" : "ok";
}
