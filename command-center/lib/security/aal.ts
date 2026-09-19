/**
 * Small pure helpers for the two-factor (TOTP) security board.
 *
 * Supabase Auth reports an Authenticator Assurance Level per session:
 * `aal1` (password only) or `aal2` (a second factor was used this session).
 * These helpers keep that logic out of the client component so it can be
 * unit-tested without the SDK or a DOM.
 */
export type AalLevel = "aal1" | "aal2";

/** Coerce Supabase's assurance-level string to a known level, or null. */
export function normalizeAal(level: string | null | undefined): AalLevel | null {
  return level === "aal1" || level === "aal2" ? level : null;
}

/**
 * True when a gentle "step up" hint should show: the current session is still
 * `aal1`, yet a verified factor exists on the account. A full sign-out/in then
 * enforces `aal2`.
 */
export function needsStepUp(
  currentLevel: string | null | undefined,
  hasVerifiedFactor: boolean,
): boolean {
  return normalizeAal(currentLevel) === "aal1" && hasVerifiedFactor;
}
