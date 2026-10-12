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
 *    `price_changed` (the price on screen must be read again before a new confirm).
 */
export type RunAnswer =
  | { outcome: "started" | "replay" }
  | { outcome: "failed"; message: string; settled: boolean; priceChanged: boolean; extraOff: boolean };

export function readRunAnswer(res: { ok: boolean; status: number }, data: Record<string, unknown>, t: Dictionary, locale: string): RunAnswer {
  if (res.ok) return { outcome: "started" };
  if (res.status === 409 && data.error === "run_already_started") return { outcome: "replay" };
  const f = t.create.flow;
  const fail = (message: string, more: Partial<Extract<RunAnswer, { outcome: "failed" }>> = {}): RunAnswer => ({
    outcome: "failed",
    message,
    settled: false,
    priceChanged: false,
    extraOff: isExtraOffRefusal(data),
    ...more,
  });

  if (data.error === "price_changed") {
    const n = typeof data.credits === "number" && Number.isFinite(data.credits) ? data.credits : null;
    return fail(n !== null ? fmt(f.priceChanged, { n: formatCredits(n, locale) }) : f.priceChangedShort, { priceChanged: true });
  }
  if (typeof data.credits_held === "number" && Number.isFinite(data.credits_held))
    return fail(fmt(f.startHeld, { n: formatCredits(data.credits_held, locale) }), { settled: true });
  // No error code at all on a 5xx: a gateway or a timeout, not the route. It may have gotten through.
  if (typeof data.error !== "string" && res.status >= 500) return fail(f.startUnsure);

  const unauthorized = data.error === "github_unauthorized";
  const specific = creditRunError(data, t, locale);
  const base = specific ?? (unauthorized ? t.agents.runUnauthorized : t.agents.runFailed);
  // "could not be read ... nothing was put on hold" already says it.
  return fail(data.error === "credits_read_failed" ? base : `${base} ${f.notTaken}`);
}

/** The request itself failed (no connection, no answer): the run may or may not have been started. */
export function unsureRunAnswer(t: Dictionary): Extract<RunAnswer, { outcome: "failed" }> {
  return { outcome: "failed", message: t.create.flow.startUnsure, settled: false, priceChanged: false, extraOff: false };
}
