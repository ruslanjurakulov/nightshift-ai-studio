/**
 * The adult (18+) attestation (migration 0192): the vendors whose terms are 18+ (registry requires_adult, e.g. the Gemini
 * API terms) are sold only to a person who confirmed they are 18 or older. The record is the person's own statement,
 * written once by the database for the signed-in user only and never edited; this module only names its states.
 *
 * "unknown" is not "none": the read failed or the migration is not applied, and then nothing is drawn as refused (the
 * database, not the page, is what refuses).
 */
export type AgeState = "adult" | "minor" | "none" | "unknown";

/**
 * The terms text version this app asks people to confirm against; bump it when the 18+ wording changes. COUPLED: the
 * database's record_adult_attestation (migration 0192) accepts exactly this string and refuses any other, so a bump ships
 * with a migration that names the new one, in the same PR.
 */
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

/**
 * The answer as a paid run sees it: AgeState, plus "absent" when 0192's my_adult_attestation does not exist yet (migrations are
 * applied by hand, so the app can ship first). Absent is not a failed read: there is no gate to back, and refusing would be a dead
 * end ("try again" forever, with no box to answer in), so a run goes on as it did before 0192.
 */
export type RunAgeAnswer = AgeState | "absent";

/**
 * Whether a run started in a person's session may go on (0196: every video run spends on Gemini, whose terms are 18+). Null =
 * go on. On the queue an unread answer goes on, because the database's render_jobs run gate refuses the row itself; on Actions
 * nothing after the route asks again, so an unread answer stops the run (try again) rather than spending on Google for someone
 * who may never have answered. The one rule for Run now and a storyboard approval, the two routes that dispatch a run.
 */
export function runAgeRefusal(answer: RunAgeAnswer, backend: "queue" | "actions"): { error: string; status: number } | null {
  if (answer === "minor") return { error: "adult_only_service", status: 403 };
  if (answer === "none") return { error: "adult_attestation_required", status: 428 };
  if (answer === "unknown" && backend === "actions") return { error: "age_unavailable", status: 503 };
  return null;
}
