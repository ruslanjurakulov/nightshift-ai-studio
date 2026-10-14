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
 *     pruned and at most MAX_ENTRIES_PER_SCOPE ordinary ones (the newest) are kept per
 *     user/org/channel (unsure and blocked ones are protected, see below), so storage cannot grow. The signature (topic, options) is never stored, nor any id, title or prompt; the user
 *     id is inside the hash, so the hash of a short topic cannot be guessed without it. Another
 *     account, another channel or any changed topic or option has a different hash and never gets
 *     the key. The entry is checked again on every read (shape, hash, age), removed when the attempt
 *     settles, and cleared on sign-out (lib/create-attempt-store.ts). With no scope, or storage that
 *     throws, nothing is stored and it is memory only.
 *
 * Two states are kept with the key because a retry of the same intent must behave differently:
 *   - unsure (`u`): an answer was lost or the server said `start_unsure`. The key is kept, and a later
 *     `run_already_started` is NOT "started": a hold exists and the run may or may not have started. The
 *     key is kept as long as the hold can still exist (HOLD_MAX_AGE_MS), not the 30 minutes of an ordinary
 *     key: a new key after 30 minutes would be a second hold while the first (maybe real) one lives on;
 *   - blocked (`b`, the credits held; 0 = amount unknown): the server said `start_failed` while the hold is
 *     still held. The reference is burnt and the hold is not released, so neither the same key (it would
 *     answer "already started") nor a new one (a second hold) may be used for the SAME intent: the form
 *     refuses it until the hold has returned (HOLD_MAX_AGE_MS) or an input changes. Only the number is
 *     stored, never what was typed.
 * Both are PROTECTED entries: they are remembered for HOLD_MAX_AGE_MS and are NEVER removed earlier: not by newer
 * intents, not by pruning, not by a cap. Only ordinary entries are capped (the newest MAX_ENTRIES_PER_SCOPE) and
 * evicted. Protected ones are bounded differently: at MAX_PROTECTED_PER_SCOPE live ones in one user/org/channel
 * (in storage, or in memory when there is no scope or no storage) a NEW intent is refused, fail-closed: `keyFor`
 * throws AttemptsFullError, `status().full` is true so the form disables itself and says why, and no request is
 * made. Existing protected intents stay replayable with their own key; the slot frees when one expires.
 *
 * What the three hours are. HOLD_MAX_AGE_MS is the backend's age-out of an UNSTARTED hold (expire_credit_reservations,
 * swept by the worker about every ten minutes, or lazily at the organization's next reservation). It is not proof
 * that no run is in progress: a run that did start can outlive it, and the client's key lifetime is a frontend-only
 * limit. REMAINING RISKS: (1) after that time an unsure intent gets a new key even if its run is still alive; (2) the
 * lifetime is client-side only; (3) sessionStorage is per tab, so a second tab has separate state; (4) the fail-closed
 * limit above.
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

/** The most ORDINARY intents remembered per user/org/channel (the newest); older ones are dropped. */
export const MAX_ENTRIES_PER_SCOPE = 8;

/**
 * How long an unsure or blocked intent is remembered: a hold that never started is released about three hours
 * after it was taken (migration 0020), and until then neither the same key (a false "started") nor a new one (a
 * second hold) is right for the same intent.
 */
export const HOLD_MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** The name it had when only blocked intents used it. */
export const BLOCKED_MAX_AGE_MS = HOLD_MAX_AGE_MS;

/** The most unsure or blocked (protected) intents live at once per user/org/channel. A new intent beyond it is refused (fail-closed). */
export const MAX_PROTECTED_PER_SCOPE = 32;

/** Thrown by `keyFor` for a NEW intent while MAX_PROTECTED_PER_SCOPE protected ones are live. The forms check `status().full` first. */
export class AttemptsFullError extends Error {
  constructor() {
    super("too many unsure or blocked create attempts are still waiting");
    this.name = "AttemptsFullError";
  }
}

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
   * the stored one of this scope if it is the same intent and still fresh, else a new one (AttemptsFullError if
   * the scope is full of protected intents).
   */
  keyFor(signature: string, scope?: AttemptScope): string;
  /**
   * What is known about the intent with this signature, without making a key: whether an earlier try ended
   * without a usable answer, the credits still held after a start that definitely failed (null = not blocked), and
   * `full`: this is a NEW intent and MAX_PROTECTED_PER_SCOPE protected ones are live, so it may not be started.
   */
  status(signature: string, scope?: AttemptScope): { unsure: boolean; blocked: number | null; full: boolean };
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

/** Unsure or blocked: a hold may still exist, so these are kept for its life and are not pushed out by newer entries. */
const protectedEntry = (e: Stored) => e.u || e.b !== undefined;

const fresh = (e: Stored, t: number, maxAgeMs: number, holdMaxAgeMs: number) =>
  t - e.t <= (protectedEntry(e) ? holdMaxAgeMs : maxAgeMs) && e.t - t <= SKEW_MS;

/**
 * Which ORDINARY entries to drop to stay within MAX_ENTRIES_PER_SCOPE (the oldest), never `keep`. Protected entries
 * are not touched here, and never dropped for room: they leave by age or settle only.
 */
function overflow<T extends { id: string; at: number; prot: boolean }>(items: T[], keep: string): T[] {
  const group = items.filter((i) => !i.prot).sort((a, b) => b.at - a.at);
  const drop: T[] = [];
  let kept = 0;
  for (const i of group) {
    if (i.id === keep || kept < MAX_ENTRIES_PER_SCOPE) kept++;
    else drop.push(i);
  }
  return drop;
}

/** The names of this scope's live protected entries in storage (for the fail-closed count). */
function storedProtected(tag: string, t: number, maxAgeMs: number, holdMaxAgeMs: number): string[] {
  const s = attemptStore();
  if (!s) return [];
  const mine = ATTEMPT_PREFIX + tag + ":";
  const out: string[] = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const name = s.key(i);
      if (!name || !name.startsWith(mine)) continue;
      const raw = s.getItem(name);
      const e = raw === null ? null : parseStored(raw);
      if (e && name === `${mine}${e.h}` && fresh(e, t, maxAgeMs, holdMaxAgeMs) && protectedEntry(e)) out.push(name);
    }
  } catch {
    /* an unreadable store has none we can count */
  }
  return out;
}

function readStored(name: string, hash: string, t: number, maxAgeMs: number, holdMaxAgeMs: number, prune = true): Stored | null {
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
  const ok = e && e.h === hash && fresh(e, t, maxAgeMs, holdMaxAgeMs) ? e : null;
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
 * one per intent (the bare scope name), then the ordinary ones over the cap (see `overflow`; never `keep`).
 */
function pruneScope(tag: string, keep: string, t: number, maxAgeMs: number, holdMaxAgeMs: number): void {
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
  const live: { id: string; at: number; prot: boolean }[] = [];
  for (const name of names) {
    let raw: string | null = null;
    try {
      raw = s.getItem(name);
    } catch {
      /* unreadable: dropped below */
    }
    const e = raw === null || name === mine ? null : parseStored(raw);
    if (e && name === `${mine}:${e.h}` && fresh(e, t, maxAgeMs, holdMaxAgeMs)) live.push({ id: name, at: e.t, prot: protectedEntry(e) });
    else if (name !== keep) removeStored(name);
  }
  for (const o of overflow(live, keep)) removeStored(o.id);
}

export function createAttempt(
  makeKey: () => string = newAttemptKey,
  opts: { now?: () => number; maxAgeMs?: number; holdMaxAgeMs?: number } = {},
): CreateAttempt {
  const { now = Date.now, maxAgeMs = MAX_AGE_MS, holdMaxAgeMs = BLOCKED_MAX_AGE_MS } = opts;
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
  const isProtected = (p: Pending) => p.unsure || p.blocked !== null;
  const limit = (p: Pending) => (isProtected(p) ? holdMaxAgeMs : maxAgeMs);
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
  const trim = (t: number, keep: Pending) => {
    for (const [id, p] of pending) if (p !== keep && !alive(p, t)) pending.delete(id);
    const items = [...pending].map(([id, p]) => ({ id, at: p.at, prot: isProtected(p) }));
    const keepId = [...pending].find(([, p]) => p === keep)?.[0] ?? "";
    for (const o of overflow(items, keepId)) pending.delete(o.id);
  };
  // Live protected intents of the same scope (storage and memory; memory-only entries have no tag).
  const protectedCount = (store: Pending["store"], t: number) => {
    const ids = new Set<string>();
    for (const [id, p] of pending) if (alive(p, t) && isProtected(p) && p.store?.tag === store?.tag) ids.add(id);
    if (store) for (const name of storedProtected(store.tag, t, maxAgeMs, holdMaxAgeMs)) ids.add(name);
    return ids.size;
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
        const found = readStored(store.name, store.hash, t, maxAgeMs, holdMaxAgeMs);
        if (found) p = { key: found.k, sig: signature, at: found.t, unsure: found.u, blocked: found.b ?? null, store };
      }
      if (!p) {
        // Fail closed: no key, so no request, while the scope is full of intents whose holds may still be live.
        if (protectedCount(store, t) >= MAX_PROTECTED_PER_SCOPE) throw new AttemptsFullError();
        p = { key: makeKey(), sig: signature, at: t, unsure: false, blocked: null, store };
        writeStored(p);
        if (store) pruneScope(store.tag, store.name, t, maxAgeMs, holdMaxAgeMs);
      }
      pending.set(id, p);
      trim(t, p);
      cur = p;
      return p.key;
    },
    status(signature, scope) {
      const t = now();
      const store = storeFor(signature, scope);
      const p = pending.get(idOf(signature, store));
      if (alive(p, t)) return { unsure: p.unsure, blocked: p.blocked, full: false };
      if (store) {
        const found = readStored(store.name, store.hash, t, maxAgeMs, holdMaxAgeMs, false);
        if (found) return { unsure: found.u, blocked: found.b ?? null, full: false };
      }
      return { unsure: false, blocked: null, full: protectedCount(store, t) >= MAX_PROTECTED_PER_SCOPE };
    },
    markUnsure(key) {
      const p = byKey(key);
      if (!p) return;
      // The hold's life runs from when this became unsure, not from when the key was first made.
      if (!p.unsure) p.at = now();
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
