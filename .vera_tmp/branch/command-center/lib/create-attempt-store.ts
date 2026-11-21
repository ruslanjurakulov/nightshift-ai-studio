/**
 * The storage half of the create attempt (lib/create-attempt.ts), kept apart and import-free so
 * sign-out can clear it without loading the create form. Every access is wrapped: blocked, full or
 * throwing storage means "nothing", and the attempt then lives in memory exactly as without it.
 *
 * sessionStorage, not localStorage: it is per tab and gone when the tab closes, and a reload of the
 * tab keeps it, which is the one case this exists for.
 */

export const ATTEMPT_PREFIX = "ns.create-attempt.v1:";

/**
 * Set by sign-out so that a request still in flight at that moment cannot write its entry back; the
 * next create form that opens switches persistence on again.
 */
let blocked = false;
export const allowAttemptStorage = () => {
  blocked = false;
};
export const attemptStorageBlocked = () => blocked;

export function attemptStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Removes every create attempt in this tab: called on sign-out. */
export function clearAllCreateAttempts(): void {
  blocked = true;
  const s = attemptStore();
  if (!s) return;
  const names: string[] = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(ATTEMPT_PREFIX)) names.push(k);
    }
  } catch {
    /* an unreadable store has no keys we can name */
  }
  for (const k of names) {
    try {
      s.removeItem(k);
    } catch {
      /* nothing more to do */
    }
  }
}
