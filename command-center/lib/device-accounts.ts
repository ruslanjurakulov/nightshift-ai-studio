/**
 * The accounts kept on this device (the avatar menu's account list, as a messenger keeps several accounts signed in).
 *
 * One account is ACTIVE: its session is the ordinary Supabase auth cookie every page, route and RLS policy reads. The others
 * are PARKED: their sessions sit in httpOnly cookies (lib/server/device-accounts.ts) that no Supabase client and no page
 * script ever reads, so a parked account can do nothing until a person switches to it and the server has asked Supabase
 * for a fresh session. This file is the part both sides share: the limit, the slot numbers, and what the browser is shown
 * about an account (a masked email and an initial, never a token, never a full address of an account not in view).
 */

/** At most three accounts per browser, the active one included (Telegram's limit). */
export const MAX_DEVICE_ACCOUNTS = 3;

/** The parked accounts' slots. The active account has none. */
export const PARKED_SLOTS = [1, 2] as const;
export type ParkedSlot = (typeof PARKED_SLOTS)[number];

export function isParkedSlot(value: unknown): value is ParkedSlot {
  return typeof value === "number" && (PARKED_SLOTS as readonly number[]).includes(value);
}

/** What the menu draws for one account. `slot` is null for the active account. */
export interface DeviceAccountView {
  slot: ParkedSlot | null;
  /** The slot's current occupant, as a precondition a request names back (lib/server/device-accounts.ts); null when active. */
  nonce: string | null;
  current: boolean;
  /** The profile name when there is one, else null (the masked email stands in). */
  name: string | null;
  /** Masked (j***@gmail.com) for a parked account; the active account's own address in full, for the person using it. */
  maskedEmail: string;
  initial: string;
  /** The stored session was refused by the auth server: the row reads "Sign in again", it is never dropped silently. */
  stale: boolean;
}

export interface DeviceAccountsAnswer {
  accounts: DeviceAccountView[];
  /** Whether another account may be added (fewer than MAX_DEVICE_ACCOUNTS on this device). */
  canAdd: boolean;
}

/**
 * j***@gmail.com: enough for the owner to tell his accounts apart, not enough to read an address off a shared screen.
 * Anything that is not an address reads as a row of stars rather than being shown.
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "***";
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${Array.from(local)[0]}***@${domain}`;
}

export function accountInitial(name: string | null | undefined, email: string | null | undefined): string {
  const source = (name ?? "").trim() || (email ?? "").trim();
  const first = Array.from(source)[0];
  return first ? first.toUpperCase() : "?";
}

/** The profile name a Supabase user carries (full_name, then name), trimmed and bounded, or null. */
export function profileName(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;
  for (const key of ["full_name", "name"]) {
    const v = m[key];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 80);
  }
  return null;
}

/** The routes (lib/server/device-accounts.ts): listed together so the middleware gate and the tests agree. */
export const DEVICE_ACCOUNTS_API = "/api/account/accounts";
export const DEVICE_ACCOUNTS_SWITCH = `${DEVICE_ACCOUNTS_API}/switch`;
export const DEVICE_ACCOUNTS_ADD = `${DEVICE_ACCOUNTS_API}/add`;
export const DEVICE_ACCOUNTS_LOGOUT = `${DEVICE_ACCOUNTS_API}/logout`;
/** Where "Add account" sends the browser: the normal sign-in page, with nothing skipped. */
export const ADD_ACCOUNT_LOGIN = "/login?add=1";

/** A slot's nonce as the browser names it back: 16 hex characters, or not one. */
export function isNonce(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
}

/** The BroadcastChannel this browser's tabs hear a switch, an add or a sign-out on, so none keeps acting as the old account. */
export const DEVICE_ACCOUNTS_CHANNEL = "ns-device-accounts";
