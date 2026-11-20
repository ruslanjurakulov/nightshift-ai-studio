/**
 * The adult (18+) attestation (migration 0199): the vendors whose terms are 18+ (registry requires_adult, e.g. the Gemini
 * API terms) are sold only to a person who confirmed they are 18 or older. The record is the person's own statement,
 * written once by the database for the signed-in user only and never edited; this module only names its states.
 *
 * "unknown" is not "none": the read failed or the migration is not applied, and then nothing is drawn as refused (the
 * database, not the page, is what refuses).
 */
export type AgeState = "adult" | "minor" | "none" | "unknown";

/** The terms text version this app asks people to confirm against; bump it when the 18+ wording changes. */
export const AGE_TERMS_VERSION = "2026-11-20";

/** How the confirmation was asked: chosen by the server from the session (Google) or by the page that asked. */
export type AgeMethod = "email_signup" | "google" | "welcome" | "create";
export const AGE_PAGE_METHODS = ["welcome", "create"] as const;

export function coerceAgeState(raw: unknown): AgeState {
  const state = raw && typeof raw === "object" ? (raw as { state?: unknown }).state : undefined;
  return state === "adult" || state === "minor" || state === "none" ? state : "unknown";
}

/** Should the page ask? Only when the database answered "none": unknown is never a reason to stop anyone. */
export const mustAsk = (s: AgeState) => s === "none";

/** The model lock for an adult-only model (registry requires_adult): locked for "none" and "minor", never for adult or unknown. */
export function adultLock(model: { adultOnly?: boolean }, state: AgeState): "adult_only" | null {
  return model.adultOnly && (state === "none" || state === "minor") ? "adult_only" : null;
}
