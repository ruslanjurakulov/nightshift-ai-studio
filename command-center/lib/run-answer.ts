import { fmt, type Dictionary } from "@/lib/i18n";
import { creditRunError, formatCredits, isExtraOffRefusal } from "@/lib/credits";

/**
 * What POST /api/agent/run said, as the screen needs it (Create and Run now).
 *
 * Every failure says whether credits were taken. The route answers `credits_held`
 * exactly when a hold was taken before the failure; without it nothing was held.
 * The one case that cannot be told is no usable answer at all (a dropped
 * connection, or a gateway error with no body): then the sentence says so.
 *
 *  - started: 200.
 *  - replay: 409 `run_already_started` — the same key got through before; nothing new was held.
 *    Shown as started (its progress is the proof), never as a failure.
 *  - failed: everything else. `settled` = the key is spent (a hold was taken but the run did not
 *    start, so the same key could only ever answer "already started"); `priceChanged` = 409
 *    `price_changed` (the price on screen must be read again before a new confirm); `unsure` = no
 *    usable answer, a hold may exist under the key.
 *
 * A keyed request that took a hold and then failed to START answers (lib/server/run-start.ts):
 *  - `start_failed` (definite, nothing started): `credits_held` is the amount still held, or `false` once
 *    the hold was released. The reference is burnt either way. Only `retry_with_new_key` WITH
 *    `credits_held: false` lets the next press use a new key (`settled`). While credits are held
 *    (`blockedCredits`, 0 = unknown), the same key would answer "already started" (a false "started")
 *    and a new key would take a second hold, so the same intent may not be sent again until the hold
 *    returns; changing an input is a new intent and works as usual.
 *  - `start_unsure` (ambiguous, may have started): the key is kept, the attempt is unsure, nothing is
 *    retried. The press after it is answered `run_already_started`, which then is NOT "started": it is
 *    the honest "a hold exists, it may or may not have started" (`earlierUnsure`).
 * Both are read BEFORE the plain numeric `credits_held` of the older answers, which stay as they were.
 *
 * `price_changed` alone does not prove nothing was held: the route compares the price BEFORE it looks
 * for an existing hold with the same key, so a retry of an unanswered attempt whose price went up
 * is answered `price_changed` although a hold exists. `earlierUnsure` (an earlier try under this key
 * ended without a usable answer) turns that case into the "cannot tell" sentence, and the key is kept:
 * confirming again at the new price is answered `run_already_started` if the hold exists.
 * Credits held and the hold expiring: migration 0020 (a hold that never started is released after 3 hours).
 */
export type RunAnswer =
  | { outcome: "started" | "replay" }
  | {
      outcome: "failed";
      message: string;
      settled: boolean;
      priceChanged: boolean;
      extraOff: boolean;
      unsure: boolean;
      /** The start definitely failed and this many credits (0 = unknown) are still held: the same intent may not be sent again. */
      blockedCredits: number | null;
    };

export function readRunAnswer(
  res: { ok: boolean; status: number },
  data: Record<string, unknown>,
  t: Dictionary,
  locale: string,
  earlierUnsure = false,
): RunAnswer {
  if (res.ok) return { outcome: "started" };
  const f = t.create.flow;
  if (res.status === 409 && data.error === "run_already_started") {
    // After an unanswered or ambiguous try this is not a start: a hold exists, and nothing says the run began.
    if (earlierUnsure) return failure(f.startUnsureReplay, { unsure: true });
    return { outcome: "replay" };
  }
  const fail = (message: string, more: Partial<Extract<RunAnswer, { outcome: "failed" }>> = {}): RunAnswer => failure(message, more, isExtraOffRefusal(data));

  // The server's own account of a failed start. Before the numeric credits_held below: that one rotates the key.
  if (data.error === "start_unsure") {
    const n = heldAmount(data.credits_held);
    return fail(n !== null && n > 0 ? fmt(f.startUnsureHeld, { n: formatCredits(n, locale) }) : f.startUnsure, { unsure: true });
  }
  if (data.error === "start_failed") {
    const n = heldAmount(data.credits_held);
    // Released (false) and told to rotate: nothing is held, the burnt reference is left behind, the next press is a new attempt.
    if (data.credits_held === false) {
      const rotate = data.retry_with_new_key === true;
      // Released but not told to rotate: the burnt reference would answer "already started", so a replay must not read as success.
      return fail(f.startFailedReleased, { settled: rotate, unsure: !rotate });
    }
    // Still held (an amount, or "yes" without one): this intent waits for the hold to return.
    return fail(n !== null && n > 0 ? fmt(f.startFailedHeld, { n: formatCredits(n, locale) }) : f.startFailedHeldShort, { blockedCredits: n ?? 0 });
  }

  // A hold the server says it took wins over everything: the run did not start, the credits are held.
  if (typeof data.credits_held === "number" && Number.isFinite(data.credits_held))
    return fail(fmt(f.startHeld, { n: formatCredits(data.credits_held, locale) }), { settled: true, priceChanged: data.error === "price_changed" });
  if (data.error === "price_changed") {
    const n = typeof data.credits === "number" && Number.isFinite(data.credits) ? data.credits : null;
    if (earlierUnsure) return fail(n !== null ? fmt(f.priceChangedUnsure, { n: formatCredits(n, locale) }) : f.startUnsure, { priceChanged: true, unsure: true });
    return fail(n !== null ? fmt(f.priceChanged, { n: formatCredits(n, locale) }) : f.priceChangedShort, { priceChanged: true });
  }
  // No error code at all on a 5xx: a gateway or a timeout, not the route. It may have gotten through.
  if (typeof data.error !== "string" && res.status >= 500) return fail(f.startUnsure, { unsure: true });

  const unauthorized = data.error === "github_unauthorized";
  const specific = creditRunError(data, t, locale);
  const base = specific ?? (unauthorized ? t.agents.runUnauthorized : t.agents.runFailed);
  // "could not be read ... nothing was put on hold" already says it.
  return fail(data.error === "credits_read_failed" ? base : `${base} ${f.notTaken}`);
}

function heldAmount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function failure(message: string, more: Partial<Extract<RunAnswer, { outcome: "failed" }>> = {}, extraOff = false): Extract<RunAnswer, { outcome: "failed" }> {
  return { outcome: "failed", message, settled: false, priceChanged: false, extraOff, unsure: false, blockedCredits: null, ...more };
}

/** The request itself failed (no connection, no answer): the run may or may not have been started. */
export function unsureRunAnswer(t: Dictionary): Extract<RunAnswer, { outcome: "failed" }> {
  return failure(t.create.flow.startUnsure, { unsure: true });
}
