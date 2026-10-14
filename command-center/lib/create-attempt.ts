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
 *   - it lives in memory, and in this tab's sessionStorage when the caller says whose it is (a
 *     `scope`: the signed-in user, the organization if known, the channel). A reload after a lost
 *     answer then finds the same key and a second press cannot hold twice. What is stored is only
 *     {v, k: the key, h: a SHA-256 of user + org + channel + the signature, t: when it was made,
 *     u: whether an answer was lost}, under a storage key that is itself a hash of user + org +
 *     channel. The signature (topic, options) is never stored, nor any id, title or prompt; the user
 *     id is inside the hash, so the hash of a short topic cannot be guessed without it. Another
 *     account, another channel or any changed topic or option has a different hash and never gets
 *     the key. The entry is checked again on every read (shape, hash, age), removed when the attempt
 *     settles, and cleared on sign-out (lib/create-attempt-store.ts). With no scope, or storage that
 *     throws, nothing is stored and it is memory only.
 *
 * The server checks the price BEFORE it looks for an existing hold with the
 * key (reserveRunCredits, then reserve_credits' 23505). So a retry of an
 * unanswered attempt whose price has since gone UP is answered `price_changed`
 * even though a hold may exist. `markUnsure()` records that an attempt ended
 * without a usable answer, so that answer is not read as "nothing was held".
 */

import { ATTEMPT_PREFIX, allowAttemptStorage, attemptStorageBlocked, attemptStore } from "@/lib/create-attempt-store";
import { sha256Hex } from "@/lib/sha256-hex";

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

/** Whose attempt this is. Without a user id nothing is persisted. */
export interface AttemptScope {
  /** The signed-in user's id, from the server (getUser()). Empty/missing = do not persist. */
  userId: string;
  /** The organization, when the page knows it. */
  orgId?: string | null;
  channelId: string;
}

export interface CreateAttempt {
  /**
   * The key for an attempt with this signature: the current one if it is unchanged (and not stale), else
   * the stored one of this scope if it is the same intent and still fresh, else a new one.
   */
  keyFor(signature: string, scope?: AttemptScope): string;
  /** The current attempt ended without a usable answer: a hold may exist under its key. */
  markUnsure(): void;
  /** An earlier try under the current key ended without a usable answer. */
  isUnsure(): boolean;
  /** The attempt is over for good (started, replayed, or failed after a hold): the next one starts fresh. */
  settle(): void;
}

/** What is written to sessionStorage: nothing a person typed, only a one-way hash of it. */
interface Stored {
  v: 1;
  k: string;
  h: string;
  t: number;
  u: boolean;
}

interface Pending {
  key: string;
  sig: string;
  at: number;
  unsure: boolean;
  /** Where this attempt is mirrored, and the hash that proves what it is for; null = memory only. */
  store: { name: string; hash: string } | null;
}

const STORED_KEY_RE = /^[A-Za-z0-9_:.-]{1,100}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** A clock that jumped back by more than this makes an entry's age unknowable: it is not trusted. */
const SKEW_MS = 60 * 1000;

function storeNameFor(scope: AttemptScope): string {
  return ATTEMPT_PREFIX + sha256Hex(`${scope.userId}\0${scope.orgId ?? ""}\0${scope.channelId}`);
}

function intentHash(scope: AttemptScope, signature: string): string {
  return sha256Hex(`${scope.userId}\0${scope.orgId ?? ""}\0${scope.channelId}\0${signature}`);
}

function readStored(name: string, hash: string, t: number, maxAgeMs: number): Stored | null {
  const s = attemptStore();
  if (!s) return null;
  let raw: string | null;
  try {
    raw = s.getItem(name);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let ok: Stored | null = null;
  try {
    const e = JSON.parse(raw) as Partial<Stored> | null;
    if (
      e &&
      typeof e === "object" &&
      e.v === 1 &&
      typeof e.k === "string" &&
      STORED_KEY_RE.test(e.k) &&
      typeof e.h === "string" &&
      HEX64.test(e.h) &&
      typeof e.t === "number" &&
      Number.isFinite(e.t) &&
      typeof e.u === "boolean" &&
      e.h === hash &&
      t - e.t <= maxAgeMs &&
      e.t - t <= SKEW_MS
    ) {
      ok = { v: 1, k: e.k, h: e.h, t: e.t, u: e.u };
    }
  } catch {
    /* tampered or truncated: ignored below */
  }
  // Whatever is under this name and is not this intent's live entry is of no use to anyone: drop it.
  if (!ok) removeStored(name);
  return ok;
}

function writeStored(p: Pending): void {
  if (!p.store || attemptStorageBlocked()) return;
  const s = attemptStore();
  if (!s) return;
  const e: Stored = { v: 1, k: p.key, h: p.store.hash, t: p.at, u: p.unsure };
  try {
    s.setItem(p.store.name, JSON.stringify(e));
  } catch {
    /* full or blocked: the attempt is still held in memory */
  }
}

function removeStored(name: string): void {
  const s = attemptStore();
  if (!s) return;
  try {
    s.removeItem(name);
  } catch {
    /* nothing more to do */
  }
}

export function createAttempt(
  makeKey: () => string = newAttemptKey,
  opts: { now?: () => number; maxAgeMs?: number } = {},
): CreateAttempt {
  const { now = Date.now, maxAgeMs = MAX_AGE_MS } = opts;
  // A form opening after a sign-out switches persistence back on (the sign-out had switched it off).
  allowAttemptStorage();
  let cur: Pending | null = null;
  return {
    keyFor(signature, scope) {
      const t = now();
      const store = scope && scope.userId && scope.channelId && !attemptStorageBlocked() ? { name: storeNameFor(scope), hash: intentHash(scope, signature) } : null;
      if (cur && cur.sig === signature && cur.store?.name === store?.name && cur.store?.hash === store?.hash && t - cur.at <= maxAgeMs) return cur.key;
      cur = null;
      if (store) {
        const found = readStored(store.name, store.hash, t, maxAgeMs);
        if (found) cur = { key: found.k, sig: signature, at: found.t, unsure: found.u, store };
      }
      if (!cur) {
        cur = { key: makeKey(), sig: signature, at: t, unsure: false, store };
        writeStored(cur);
      }
      return cur.key;
    },
    markUnsure() {
      if (!cur) return;
      cur.unsure = true;
      writeStored(cur);
    },
    isUnsure() {
      return cur?.unsure ?? false;
    },
    settle() {
      if (cur?.store) removeStored(cur.store.name);
      cur = null;
    },
  };
}
