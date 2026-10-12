/**
 * One "make a video" intent's idempotency key, for Create and Run now.
 *
 * POST /api/agent/run holds credits and starts a run. Without a key the hold
 * gets a random reference, so a response that never arrived, a double click or
 * a retry after an error is a second hold and a second job. With a key the
 * route derives the reference from (user, channel, key)
 * (lib/server/credits.ts runCreditRefFor): the same key again is refused as
 * `run_already_started` (409) and nothing new is held or dispatched. (Where
 * credits are not enforced there is no hold, and the key does nothing.)
 *
 * The rule here is what makes that safe in the browser:
 *   - one intent = one key. The caller passes a signature of what the person
 *     decided: the channel, the topic and the options (length, language, look,
 *     voice...). The same signature gets the same key again (a double click, a
 *     retry after an error or a timeout);
 *   - the PRICE is deliberately not part of the signature. If an answer is lost
 *     after the server already held credits and the price then moves, a new key
 *     would be a second hold. The price travels as `max_credits` instead;
 *   - it changes when the signature changes: the route's reference does not
 *     look at the body, so a changed brief under an old key would be refused as
 *     "already started" although it is a different video;
 *   - it ends when the attempt is settled for good: a confirmed start, an
 *     "already started" answer, or a failure that the server says kept a hold
 *     (`credits_held`), where a replay of the key could only answer "already
 *     started" and never run anything;
 *   - it is dropped after MAX_AGE_MS. The reference outlives the hold on the
 *     server, so a key kept for hours would turn a deliberate new video with the
 *     same inputs into "already started";
 *   - it lives in memory only. Nothing is stored, so it cannot be found by
 *     another account on the same browser or reach another channel: each
 *     channel's form has its own attempt. (A reload loses it; the hold then
 *     expires on its own, see lib/run-answer.ts.)
 *
 * The server checks the price BEFORE it looks for an existing hold with the
 * key (reserveRunCredits, then reserve_credits' 23505). So a retry of an
 * unanswered attempt whose price has since gone UP is answered `price_changed`
 * even though a hold may exist. `markUnsure()` records that an attempt ended
 * without a usable answer, so that answer is not read as "nothing was held".
 */

/** Same alphabet the route accepts (IDEMPOTENCY_KEY_RE), well under 255. */
export function newAttemptKey(): string {
  const c = typeof globalThis.crypto !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") return `create-${c.randomUUID()}`;
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `create-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** How long an unanswered attempt's key is kept. */
export const MAX_AGE_MS = 30 * 60 * 1000;

export interface CreateAttempt {
  /** The key for an attempt with this signature: the current one if it is unchanged (and not stale), else a new one. */
  keyFor(signature: string): string;
  /** The current attempt ended without a usable answer: a hold may exist under its key. */
  markUnsure(): void;
  /** An earlier try under the current key ended without a usable answer. */
  isUnsure(): boolean;
  /** The attempt is over for good (started, replayed, or failed after a hold): the next one starts fresh. */
  settle(): void;
}

interface Pending {
  key: string;
  sig: string;
  at: number;
  unsure: boolean;
}

export function createAttempt(
  makeKey: () => string = newAttemptKey,
  opts: { now?: () => number; maxAgeMs?: number } = {},
): CreateAttempt {
  const { now = Date.now, maxAgeMs = MAX_AGE_MS } = opts;
  let cur: Pending | null = null;
  return {
    keyFor(signature) {
      const t = now();
      if (!cur || cur.sig !== signature || t - cur.at > maxAgeMs) cur = { key: makeKey(), sig: signature, at: t, unsure: false };
      return cur.key;
    },
    markUnsure() {
      if (cur) cur.unsure = true;
    },
    isUnsure() {
      return cur?.unsure ?? false;
    },
    settle() {
      cur = null;
    },
  };
}
