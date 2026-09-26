/**
 * Small pure helpers behind the error screens, the confirm dialog and the copy
 * button. Kept free of React and the DOM so the rules are pinned by tests.
 */

/**
 * The only piece of a thrown error an error screen may show: Next's `digest`,
 * an opaque hash the server logs alongside the real error. The message and the
 * stack never reach the page — a failed GitHub or Supabase call can carry a
 * URL, a token prefix or a row in its message, and an error screen is exactly
 * where someone takes a screenshot to ask for help.
 *
 * The digest itself is whatever the error object says it is, so it is shown
 * only if it still looks like one: short, and nothing but word characters.
 */
export function safeDigest(digest: unknown): string | null {
  if (typeof digest !== "string") return null;
  const d = digest.trim();
  if (!d || d.length > 64) return null;
  return /^[A-Za-z0-9_-]+$/.test(d) ? d : null;
}

/**
 * Where Tab goes inside a modal: forward past the last control wraps to the
 * first, Shift+Tab before the first wraps to the last. `current` is -1 when
 * focus is outside the dialog (it came back from the address bar, say), which
 * lands on the first control going forward and the last going back.
 */
export function nextFocusIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return backwards ? count - 1 : 0;
  if (backwards) return current === 0 ? count - 1 : current - 1;
  return current === count - 1 ? 0 : current + 1;
}

export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

/**
 * Copy text, and say honestly whether it worked. The async Clipboard API is
 * missing on plain http and blocked in some embedded browsers; a caller that
 * assumed success would toast "Copied" over an empty clipboard.
 */
export async function copyText(text: string, clipboard: ClipboardLike | undefined | null): Promise<boolean> {
  if (!clipboard || typeof clipboard.writeText !== "function") return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
