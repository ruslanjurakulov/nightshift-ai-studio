/**
 * A one-line notice that has to survive a navigation: the reset page ends with
 * a full page change into the app, where the toast host lives. The code (never
 * text) goes into sessionStorage and the app shell shows it once.
 */

export const FLASH_KEY = "ns_flash";
export const FLASH_CODES = ["password_changed"] as const;
export type FlashCode = (typeof FLASH_CODES)[number];

export function isFlashCode(value: unknown): value is FlashCode {
  return typeof value === "string" && (FLASH_CODES as readonly string[]).includes(value);
}

export function setFlash(code: FlashCode, storage: Pick<Storage, "setItem"> | null = safeSession()): void {
  try {
    storage?.setItem(FLASH_KEY, code);
  } catch {
    /* private window: the notice is a courtesy */
  }
}

/** Read the notice once and clear it. */
export function takeFlash(storage: Pick<Storage, "getItem" | "removeItem"> | null = safeSession()): FlashCode | null {
  try {
    const value = storage?.getItem(FLASH_KEY) ?? null;
    storage?.removeItem(FLASH_KEY);
    return isFlashCode(value) ? value : null;
  } catch {
    return null;
  }
}

function safeSession(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
