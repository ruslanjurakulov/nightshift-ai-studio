/**
 * "Run now": what to tell the caller when the hold was taken and then the
 * START failed (the render_jobs insert, or the Actions dispatch).
 *
 * Why it matters. A keyed request (`idempotency_key`) holds under a reference
 * that is the same for (user, channel, key), and reserve_credits() refuses ANY
 * existing job_id with 23505 — released or expired ones too. So after a failed
 * start the reference is burnt: a retry with the same key is answered
 * `run_already_started`, which the page reads as "it started". Two honest
 * answers replace the old, undifferentiated "something failed":
 *
 *  - `start_failed`  — DEFINITE: the other side refused (a 4xx from PostgREST
 *    or GitHub), so nothing was started. The old reference is burnt: the
 *    caller must retry with a NEW key (`retry_with_new_key`). Never
 *    re-dispatched here.
 *  - `start_unsure`  — AMBIGUOUS: the request may have been sent and acted on
 *    (timeout, dropped connection, a 5xx from a gateway). Nothing is
 *    released and nothing is dispatched again; the caller keeps its key and
 *    says it cannot tell. A retry with the same key is answered
 *    `run_already_started`, which is true: a hold exists.
 *
 * `credits_held` is what is still held: the amount (as `credits_held` has
 * always been), or `false` once a definite failure's hold has been released.
 * TODAY NOTHING RELEASES IT: release_credits() is service-only (0020), this
 * app never holds the service key, and no user-callable release exists for an
 * unstarted Run now hold (the storyboard path has one, 0057
 * storyboard_dispatch_failed; Run now does not). The hold expires back within
 * three hours (0020 expire_credit_reservations; reserve_credits() also frees
 * stale holds of the organization first, 0094). See the PR for the migration
 * that would close this.
 */

export type StartOutcome = "failed" | "unsure";

/** A response that was received and says no, before doing anything. 408 means the server gave up waiting, which may be after the work. */
export function refusedStatus(status: unknown): boolean {
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408;
}

/**
 * A render_jobs insert that returned an error. supabase-js turns a failed
 * fetch into `{error, status: 0}` rather than throwing, and a gateway can
 * answer 5xx after the row was written, so only a received 4xx (PostgREST
 * rolls the statement back) is definite. An unknown status is unsure.
 */
export function insertOutcome(res: { status?: unknown }): StartOutcome {
  return refusedStatus(res.status) ? "failed" : "unsure";
}

const DEFINITE_DISPATCH = new Set([
  "github_unauthorized",
  "github_workflow_not_found",
  "github_not_configured",
  "github_workflow_not_allowed",
]);

/**
 * A thrown dispatch error. dispatchWorkflow() throws a named reason after it
 * received GitHub's answer (401/403/404 are refusals; any other status carries
 * `status`), and the bare fetch error (timeout, reset, DNS) when it got none.
 */
export function dispatchOutcome(e: unknown): { outcome: StartOutcome; reason: string } {
  const message = e instanceof Error ? e.message : "";
  const reason = /^github_[a-z_]+$/.test(message) ? message : "github_dispatch_failed";
  if (DEFINITE_DISPATCH.has(reason)) return { outcome: "failed", reason };
  const status = (e as { status?: unknown } | null)?.status;
  return { outcome: refusedStatus(status) ? "failed" : "unsure", reason };
}

/** The body for a keyed request whose start failed after its hold. `held`: the amount still held, `true` if unknown, `false` once released. */
export function startFailureBody(
  outcome: StartOutcome,
  reason: string,
  held: number | boolean,
): Record<string, unknown> {
  return outcome === "failed"
    ? { error: "start_failed", reason, credits_held: held, retry_with_new_key: true }
    : { error: "start_unsure", reason, credits_held: held };
}
