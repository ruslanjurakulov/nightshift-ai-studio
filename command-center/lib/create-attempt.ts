/**
 * One "Create" attempt's idempotency key, for the guided create flow.
 *
 * POST /api/agent/run holds credits and starts a run. Without a key the hold
 * gets a random reference, so a response that never arrived, a second tab or a
 * retry after the error state is a second hold and a second job. With a key
 * the route derives the reference from (user, channel, key)
 * (lib/server/credits.ts runCreditRefFor): the same key again is refused as
 * `run_already_started` (409) and nothing new is held or dispatched.
 *
 * The rule here is what makes that safe in the browser:
 *   - the key is made when an attempt first needs one, and the SAME key goes
 *     out again for the same inputs (a retry after an error or a timeout);
 *   - it changes when the inputs change — the route's reference does not look
 *     at the body, so a changed brief under an old key would be refused as
 *     "already started" although it is a different video;
 *   - it changes after the attempt is settled for good: a confirmed start, or
 *     a failure that the server says kept a hold (`credits_held`) — a replay of
 *     that key could only answer "already started" and never run anything.
 *
 * `max_credits` is deliberately NOT part of the signature: the price drifting
 * under an unanswered attempt must not turn a retry into a second hold.
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

export interface CreateAttempt {
  /** The key for an attempt with these inputs: the current one if the inputs are unchanged, else a new one. */
  keyFor(signature: string): string;
  /** The attempt is over for good (started, or failed after a hold): the next one starts fresh. */
  settle(): void;
}

export function createAttempt(makeKey: () => string = newAttemptKey): CreateAttempt {
  let key: string | null = null;
  let sig: string | null = null;
  return {
    keyFor(signature) {
      if (key === null || sig !== signature) {
        key = makeKey();
        sig = signature;
      }
      return key;
    },
    settle() {
      key = null;
      sig = null;
    },
  };
}
