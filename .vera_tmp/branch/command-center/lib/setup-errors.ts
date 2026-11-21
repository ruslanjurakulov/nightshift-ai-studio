import { fmt } from "@/lib/i18n/core";
import type { Dictionary } from "@/lib/i18n";
import type { OperatorResult } from "@/lib/operator-post";

/**
 * The words for a failed write to /api/setup/secrets or /api/setup/variables.
 *
 * Maps the route's stable error codes to short, translated sentences. The only
 * thing ever put into a sentence is the secret or variable NAME the server
 * names (and only if it looks like one): never the value, a prefix of it or its
 * length, and never the reason text of a refused value.
 */
export function setupFailureText(
  t: Pick<Dictionary, "providers" | "mfa">,
  data: { error?: unknown; name?: unknown; reason?: unknown } | null | undefined,
  fallback: string,
): string {
  switch (data?.error) {
    case "mfa_recent_required":
      return t.mfa.recentRequired;
    case "mfa_enrol_required":
      return t.mfa.enrolRequired;
    case "rate_limited":
      return t.providers.rateLimited;
    case "bad_value": {
      const name = typeof data.name === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(data.name) ? data.name : null;
      return name ? fmt(t.providers.badValue, { name }) : fallback;
    }
    default:
      return fallback;
  }
}

type FailedResult = Extract<OperatorResult, { ok: false }>;

/**
 * The owner sentence for a failed owner action, by WHY it failed (lib/operator-post.ts). A session that ended, a missing
 * second step, a refusal, a dropped connection and a server error each say their own thing; only the last one (and a
 * route's own refusal code, via setupFailureText) falls back to the caller's per-action sentence.
 *
 * `uncertain` is for actions that write a record the app cannot undo or de-duplicate (a recorded payment): when the
 * answer never arrived it may still have gone through, so those two sentences add "check the history first". A server
 * error uses the caller's sentence, which for a payment says the same.
 */
export function operatorFailureText(
  t: Pick<Dictionary, "providers" | "mfa" | "ownerTruth">,
  failure: Pick<FailedResult, "kind" | "data">,
  fallback: string,
  uncertain = false,
): string {
  const tail = (text: string) => (uncertain ? `${text} ${t.ownerTruth.checkBeforeRetry}` : text);
  switch (failure.kind) {
    case "session":
      return t.ownerTruth.sessionEnded;
    case "mfa":
      return failure.data?.error === "mfa_recent_required" ? t.mfa.recentRequired : t.ownerTruth.mfaRequired;
    case "mfa_enrol":
      return t.mfa.enrolRequired;
    case "forbidden":
      return t.ownerTruth.forbidden;
    case "network":
      return tail(t.ownerTruth.offline);
    case "not_recorded":
      return tail(t.ownerTruth.notRecorded);
    case "rate_limited":
      return setupFailureText(t, { ...failure.data, error: "rate_limited" }, fallback);
    default:
      // A server error or a route's own refusal: the caller's sentence (for a payment it already says to check the history).
      return setupFailureText(t, failure.data, fallback);
  }
}
