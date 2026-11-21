/**
 * The storage half of the editor drafts (lib/editor-draft.ts), kept apart and
 * import-free so sign-out can clear the drafts without loading the editor.
 * Every access is wrapped: blocked, full or throwing storage means "nothing".
 */

export const DRAFT_PREFIX = "ns.editor.draft.v1";
/**
 * Set by sign-out so that an editor that is closing at that moment cannot write
 * its draft back; the next editor that opens switches writing on again.
 */
let blocked = false;
export const allowDraftWrites = () => {
  blocked = false;
};
export const draftWritesBlocked = () => blocked;

export function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function keys(s: Storage, prefix: string): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(prefix)) out.push(k);
    }
  } catch {
    /* an unreadable store has no keys we can name */
  }
  return out;
}

export function remove(s: Storage, ks: readonly string[]): void {
  for (const k of ks) {
    try {
      s.removeItem(k);
    } catch {
      /* nothing more to do */
    }
  }
}

/** Removes every editor draft in this browser: called on sign-out. */
export function clearAllEditorDrafts(): void {
  blocked = true;
  const s = store();
  if (s) remove(s, keys(s, `${DRAFT_PREFIX}:`));
}

