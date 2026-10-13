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
 *     u: whether an answer was lost, b: the credits held after a definite start failure}, under a
 *     storage key made of a hash of user + org + channel and the intent's hash: ONE ENTRY PER
 *     INTENT, so what is known about topic A (its key, unsure, blocked) is still there after the
 *     person sent topic B and typed A back. Entries touch only their own intent; expired ones are
 *     pruned and at most MAX_ENTRIES_PER_SCOPE (the newest) are kept per user/org/channel, so
 *     storage cannot grow. The signature (topic, options) is never stored, nor any id, title or prompt; the user
 *     id is inside the hash, so the hash of a short topic cannot be guessed without it. Another
 *     account, another channel or any changed topic or option has a different hash and never gets
 *     the key. The entry is checked again on every read (shape, hash, age), removed when the attempt
 *     settles, and cleared on sign-out (lib/create-attempt-store.ts). With no scope, or storage that
 *     throws, nothing is stored and it is memory only.
 *
 * Two states are kept with the key because a retry of the same intent must behave differently:
 *   - unsure (`u`): an answer was lost or the server said `start_unsure`. The key is kept, and a later
 *     `run_already_started` is NOT "started": a hold exists and the run may or may not have started;
 *   - blocked (`b`, the credits held; 0 = amount unknown): the server said `start_failed` while the hold is
 *     still held. The reference is burnt and the hold is not released, so neither the same key (it would
 *     answer "already started") nor a new one (a second hold) may be used for the SAME intent: the form
 *     refuses it until the hold has returned (BLOCKED_MAX_AGE_MS) or an input changes. Only the number is
 *     stored, never what was typed.
 * Both are answered about the key they were learned under: a late answer of an earlier attempt, arriving
 * after the person changed the intent, cannot mark or settle the new attempt (`key` arguments).
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

/** The most intents remembered per user/org/channel (the newest); older ones are dropped. */
export const MAX_ENTRIES_PER_SCOPE = 8;

/** How long a blocked intent stays blocked: the server returns an unstarted hold about 3 hours after it was taken. */
export const BLOCKED_MAX_AGE_MS = 3 * 60 * 60 * 1000;

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
  /**
   * What is known about the intent with this signature, without making a key: whether an earlier try ended
   * without a usable answer, and the credits still held after a start that definitely failed (null = not blocked).
   */
  status(signature: string, scope?: AttemptScope): { unsure: boolean; blocked: number | null };
  /** The attempt ended without a usable answer: a hold may exist under its key. `key`: the attempt it was learned under. */
  markUnsure(key?: string): void;
  /** An earlier try under the current key ended without a usable answer. */
  isUnsure(): boolean;
  /** The start definitely failed but `credits` (0 = unknown) are still held: this intent may not be sent again. */
  markBlocked(credits: number, key?: string): void;
  /** The attempt is over for good (started, replayed, or failed with the hold released): the next one starts fresh. */
  settle(key?: string): void;
}

/** What is written to sessionStorage: nothing a person typed, only a one-way hash of it. */
interface Stored {
  v: 1;
  k: string;
  h: string;
  t: number;
  u: boolean;
  /** Credits still held after a definite start failure (0 = amount unknown). Absent = not blocked. */
  b?: number;
}

interface Pending {
  key: string;
  sig: string;
  at: number;
  unsure: boolean;
  blocked: number | null;
  /** Where this attempt is mirrored, and the hash that proves what it is for; null = memory only. */
  store: { name: string; hash: string; tag: string } | null;
}

const STORED_KEY_RE = /^[A-Za-z0-9_:.-]{1,100}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** A clock that jumped back by more than this makes an entry's age unknowable: it is not trusted. */
const SKEW_MS = 60 * 1000;

/** The hash of whose attempts these are: the first half of every storage name of the scope. */
function scopeTag(scope: AttemptScope): string {
  return sha256Hex(`${scope.userId}\0${scope.orgId ?? ""}\0${scope.channelId}`);
}

function intentHash(scope: AttemptScope, signature: string): string {
  return sha256Hex(`${scope.userId}\0${scope.orgId ?? ""}\0${scope.channelId}\0${signature}`);
}

/** The shape of a stored entry, nothing else checked. Anything tampered with or truncated is null. */
function parseStored(raw: string): Stored | null {
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
      (e.b === undefined || (typeof e.b === "number" && Number.isFinite(e.b) && e.b >= 0 && e.b <= 1e9))
    ) {
      return { v: 1, k: e.k, h: e.h, t: e.t, u: e.u, ...(e.b === undefined ? {} : { b: e.b }) };
    }
  } catch {
    /* tampered or truncated */
  }
  return null;
}

const fresh = (e: Stored, t: number, maxAgeMs: number, blockedMaxAgeMs: number) =>
  t - e.t <= (e.b === undefined ? maxAgeMs : blockedMaxAgeMs) && e.t - t <= SKEW_MS;

function readStored(name: string, hash: string, t: number, maxAgeMs: number, blockedMaxAgeMs: number, prune = true): Stored | null {
  const s = attemptStore();
  if (!s) return null;
  let raw: string | null;
  try {
    raw = s.getItem(name);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const e = parseStored(raw);
  const ok = e && e.h === hash && fresh(e, t, maxAgeMs, blockedMaxAgeMs) ? e : null;
  // Whatever is under this intent's name and is not its live entry is of no use to anyone: drop it.
  // (A read that only asks, `prune` false, leaves it.)
  if (!ok && prune) removeStored(name);
  return ok;
}

function writeStored(p: Pending): void {
  if (!p.store || attemptStorageBlocked()) return;
  const s = attemptStore();
  if (!s) return;
  const e: Stored = { v: 1, k: p.key, h: p.store.hash, t: p.at, u: p.unsure, ...(p.blocked === null ? {} : { b: p.blocked }) };
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

/**
 * Keeps one scope's entries bounded: drops the ones that are expired, malformed, or from before entries were
 * one per intent (the bare scope name), then all but the newest MAX_ENTRIES_PER_SCOPE (never `keep`).
 */
function pruneScope(tag: string, keep: string, t: number, maxAgeMs: number, blockedMaxAgeMs: number): void {
  const s = attemptStore();
  if (!s) return;
  const mine = ATTEMPT_PREFIX + tag;
  const names: string[] = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && (k === mine || k.startsWith(mine + ":"))) names.push(k);
    }
  } catch {
    return;
  }
  const live: { name: string; at: number }[] = [];
  for (const name of names) {
    let raw: string | null = null;
    try {
      raw = s.getItem(name);
    } catch {
      /* unreadable: dropped below */
    }
    const e = raw === null || name === mine ? null : parseStored(raw);
    if (e && name === `${mine}:${e.h}` && fresh(e, t, maxAgeMs, blockedMaxAgeMs)) live.push({ name, at: e.t });
    else if (name !== keep) removeStored(name);
  }
  live.sort((a, b) => b.at - a.at);
  let kept = 0;
  for (const l of live) {
    if (l.name === keep || kept < MAX_ENTRIES_PER_SCOPE) kept++;
    else removeStored(l.name);
  }
}

export function createAttempt(
  makeKey: () => string = newAttemptKey,
  opts: { now?: () => number; maxAgeMs?: number; blockedMaxAgeMs?: number } = {},
): CreateAttempt {
  const { now = Date.now, maxAgeMs = MAX_AGE_MS, blockedMaxAgeMs = BLOCKED_MAX_AGE_MS } = opts;
  // A form opening after a sign-out switches persistence back on (the sign-out had switched it off).
  allowAttemptStorage();
  // Every intent this form has seen, each with its own key and state (the newest few), and the one asked for last.
  const pending = new Map<string, Pending>();
  let cur: Pending | null = null;
  const idOf = (signature: string, store: Pending["store"]) => (store ? store.name : `memory:${signature}`);
  const storeFor = (signature: string, scope?: AttemptScope): Pending["store"] => {
    if (!scope || !scope.userId || !scope.channelId || attemptStorageBlocked()) return null;
    const tag = scopeTag(scope);
    const hash = intentHash(scope, signature);
    return { name: `${ATTEMPT_PREFIX}${tag}:${hash}`, hash, tag };
  };
  const limit = (p: Pending) => (p.blocked === null ? maxAgeMs : blockedMaxAgeMs);
  const alive = (p: Pending | undefined, t: number): p is Pending => !!p && t - p.at <= limit(p);
  const byKey = (key?: string): Pending | null => {
    if (key === undefined) return cur;
    for (const p of pending.values()) if (p.key === key) return p;
    return null;
  };
  const forget = (p: Pending) => {
    for (const [id, q] of pending) if (q === p) pending.delete(id);
    if (cur === p) cur = null;
  };
  const trim = (t: number) => {
    for (const [id, p] of pending) if (!alive(p, t)) pending.delete(id);
    while (pending.size > MAX_ENTRIES_PER_SCOPE) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
  };
  return {
    keyFor(signature, scope) {
      const t = now();
      const store = storeFor(signature, scope);
      const id = idOf(signature, store);
      let p = pending.get(id);
      if (alive(p, t)) {
        cur = p;
        return p.key;
      }
      pending.delete(id);
      p = undefined;
      if (store) {
        const found = readStored(store.name, store.hash, t, maxAgeMs, blockedMaxAgeMs);
        if (found) p = { key: found.k, sig: signature, at: found.t, unsure: found.u, blocked: found.b ?? null, store };
      }
      if (!p) {
        p = { key: makeKey(), sig: signature, at: t, unsure: false, blocked: null, store };
        writeStored(p);
        if (store) pruneScope(store.tag, store.name, t, maxAgeMs, blockedMaxAgeMs);
      }
      pending.set(id, p);
      trim(t);
      cur = p;
      return p.key;
    },
    status(signature, scope) {
      const t = now();
      const store = storeFor(signature, scope);
      const p = pending.get(idOf(signature, store));
      if (alive(p, t)) return { unsure: p.unsure, blocked: p.blocked };
      if (store) {
        const found = readStored(store.name, store.hash, t, maxAgeMs, blockedMaxAgeMs, false);
        if (found) return { unsure: found.u, blocked: found.b ?? null };
      }
      return { unsure: false, blocked: null };
    },
    markUnsure(key) {
      const p = byKey(key);
      if (!p) return;
      p.unsure = true;
      writeStored(p);
    },
    isUnsure() {
      return cur?.unsure ?? false;
    },
    markBlocked(credits, key) {
      const p = byKey(key);
      if (!p) return;
      p.blocked = Number.isFinite(credits) && credits > 0 ? credits : 0;
      // The hold's three hours run from now, not from when this key was first made.
      p.at = now();
      writeStored(p);
    },
    settle(key) {
      const p = byKey(key);
      if (!p) return;
      if (p.store) removeStored(p.store.name);
      forget(p);
    },
  };
}
