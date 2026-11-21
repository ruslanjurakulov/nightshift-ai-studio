import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { createClient as createStatelessClient, type Session, type User } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";
import { createClient, createHeldClient } from "@/lib/supabase/server";
import { SESSION_COOKIE_MAX_AGE_SECONDS } from "@/lib/supabase/cookie-options";
import { hasVerifiedTotpFactor, mfaVerifyUrl } from "@/lib/security/admin-mfa";
import { ALL_CHANNELS_SLUG, CHANNEL_COOKIE } from "@/lib/channels";
import { ORG_COOKIE } from "@/lib/orgs";
import {
  MAX_DEVICE_ACCOUNTS,
  PARKED_SLOTS,
  accountInitial,
  maskEmail,
  profileName,
  type DeviceAccountView,
  type DeviceAccountsAnswer,
  type ParkedSlot,
} from "@/lib/device-accounts";

/**
 * The parked accounts of a device (lib/device-accounts.ts has the model).
 *
 * A parked account is one httpOnly cookie per slot holding that account's refresh token and what the menu shows (its id,
 * email and name). Why it is safe to keep it there:
 * - httpOnly: no page script can read it, so a script-injection bug can reach the ACTIVE session (whose cookie the browser
 *   client must read, lib/supabase/cookie-options.ts) but not the parked ones.
 * - Its name never matches `sb-*-auth-token`, so no Supabase client (server, middleware, browser) reads it as a session:
 *   RLS only ever sees the active account. Pinned by tests/device-accounts*.test.ts.
 * - `__Host-` in production: a sibling host cannot plant a parked cookie (with its own refresh token) for a person to
 *   "switch" into, and the cookie is always Secure, Path=/ and has no Domain.
 * - Nothing in it is trusted: a switch asks Supabase for a fresh session with the stored refresh token, and refuses when
 *   the account that comes back is not the one the cookie names (a tampered cookie). The stored id is never used to act.
 *
 * A slot's contents move on every switch, so a request also names the slot's `nonce` (new each time an account is parked):
 * a list read before another tab switched names the old occupant, and is refused rather than acting on whoever is there now.
 * The nonce is a precondition, never an identity.
 */

const VERSION = 1;
const MAX_COOKIE_CHARS = 3600;

export interface ParkedAccount {
  uid: string;
  email: string | null;
  name: string | null;
  rt: string;
  /** Seconds since the epoch when it was parked. */
  iat: number;
  /** New each time an account is parked here: what a request must name to act on this occupant. */
  nonce: string;
  /** The auth server refused this session: "Sign in again". */
  stale?: true;
}

export function parkedCookieName(slot: ParkedSlot, production: boolean = process.env.NODE_ENV === "production"): string {
  return `${production ? "__Host-" : ""}ns_acct_${slot}`;
}

export function parkedCookieOptions(production: boolean = process.env.NODE_ENV === "production") {
  return { path: "/", httpOnly: true, sameSite: "lax" as const, secure: production, maxAge: SESSION_COOKIE_MAX_AGE_SECONDS };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE = /^[0-9a-f]{16}$/;

export function newNonce(): string {
  return randomBytes(8).toString("hex");
}

export function encodeParked(p: ParkedAccount): string {
  const body = { v: VERSION, uid: p.uid, email: p.email, name: p.name, rt: p.rt, iat: p.iat, n: p.nonce, ...(p.stale ? { stale: true } : {}) };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

/** A parked account from its cookie, or null for anything malformed (which the routes then remove, never act on). */
export function decodeParked(value: string | undefined | null): ParkedAccount | null {
  if (!value || value.length > MAX_COOKIE_CHARS) return null;
  try {
    const p = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (p.v !== VERSION) return null;
    if (typeof p.uid !== "string" || !UUID.test(p.uid)) return null;
    if (typeof p.rt !== "string" || !p.rt || p.rt.length > 2048) return null;
    if (typeof p.iat !== "number" || !Number.isFinite(p.iat)) return null;
    if (typeof p.n !== "string" || !NONCE.test(p.n)) return null;
    const email = typeof p.email === "string" && p.email.length <= 320 ? p.email : null;
    const name = typeof p.name === "string" && p.name.length <= 80 ? p.name : null;
    return { uid: p.uid, email, name, rt: p.rt, iat: p.iat, nonce: p.n, ...(p.stale === true ? { stale: true as const } : {}) };
  } catch {
    return null;
  }
}

type CookieReader = { get(name: string): { value: string } | undefined };

export function readParked(store: CookieReader): Map<ParkedSlot, ParkedAccount> {
  const out = new Map<ParkedSlot, ParkedAccount>();
  for (const slot of PARKED_SLOTS) {
    const p = decodeParked(store.get(parkedCookieName(slot))?.value);
    if (p) out.set(slot, p);
  }
  return out;
}

/** Slots whose cookie is there but is not one of ours (edited, truncated, an old version): removed, never read. */
export function malformedSlots(store: CookieReader): ParkedSlot[] {
  return PARKED_SLOTS.filter((slot) => {
    const raw = store.get(parkedCookieName(slot))?.value;
    return Boolean(raw) && !decodeParked(raw);
  });
}

/** The first empty slot, or null when the device already holds the most accounts it may. */
export function freeSlot(parked: Map<ParkedSlot, ParkedAccount>): ParkedSlot | null {
  for (const slot of PARKED_SLOTS) if (!parked.has(slot)) return slot;
  return null;
}

/**
 * The active account plus the parked ones, as the menu draws them. A parked copy of the active account, and a second copy
 * of one parked account, are not listed (nor counted against the limit). The active account's own address is shown in
 * full to the person using it; the others are masked.
 */
export function accountsView(active: User | null, parked: Map<ParkedSlot, ParkedAccount>): DeviceAccountsAnswer {
  const accounts: DeviceAccountView[] = [];
  const seen = new Set<string>();
  if (active) {
    const name = profileName(active.user_metadata);
    seen.add(active.id);
    accounts.push({
      slot: null,
      nonce: null,
      current: true,
      name,
      maskedEmail: active.email ?? maskEmail(null),
      initial: accountInitial(name, active.email),
      stale: false,
    });
  }
  for (const [slot, p] of parked) {
    if (seen.has(p.uid)) continue;
    seen.add(p.uid);
    accounts.push({
      slot,
      nonce: p.nonce,
      current: false,
      name: p.name,
      maskedEmail: maskEmail(p.email),
      initial: accountInitial(p.name, p.email),
      stale: p.stale === true,
    });
  }
  return { accounts, canAdd: accounts.length < MAX_DEVICE_ACCOUNTS };
}

/** Writes or removes one slot's cookie on this request's response. */
export async function writeParked(slot: ParkedSlot, p: ParkedAccount | null): Promise<void> {
  const store = await cookies();
  if (p) store.set(parkedCookieName(slot), encodeParked(p), parkedCookieOptions());
  else store.set(parkedCookieName(slot), "", { ...parkedCookieOptions(), maxAge: 0 });
}

export type ActiveResult =
  | { kind: "ok"; user: User; session: Session }
  /** No account is signed in here (no session, or the auth server said this one is over). */
  | { kind: "none" }
  /** The auth server could not be asked: who is signed in is UNKNOWN, so nothing may be parked, dropped or replaced. */
  | { kind: "unavailable" };

const statusOf = (error: unknown): number | null => {
  const s = (error as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : null;
};

/** Refused for good (the token or session is over), as opposed to "try again" (rate limit, timeout, outage). */
const refusedForGood = (status: number | null) => status !== null && (status === 400 || status === 401 || status === 403 || status === 404);

/**
 * The active account as the auth server confirms it right now (getUser), or why it cannot say.
 *
 * Read through a client whose cookie writes are HELD: reading an expired access token makes auth-js refresh it, and a failed
 * refresh deletes the session. Those writes reach the response only when the answer is a confirmed account, so an outage
 * (or a rate limit) can neither be read as "nobody is signed in" nor delete the active cookie behind a 503.
 */
export async function activeSession(): Promise<ActiveResult> {
  const held = await createHeldClient();
  if (!held) return { kind: "unavailable" };
  const supabase = held.client;
  try {
    const { data: s, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) return refusedForGood(statusOf(sessionError)) ? { kind: "none" } : { kind: "unavailable" };
    if (!s.session || !s.session.refresh_token) return { kind: "none" };
    const { data: u, error } = await supabase.auth.getUser();
    if (error) return refusedForGood(statusOf(error)) ? { kind: "none" } : { kind: "unavailable" };
    if (!u.user) return { kind: "none" };
    // A refresh made while reading is the newest session: it goes to the browser, or the cookie would hold a spent token.
    held.commit();
    return { kind: "ok", user: u.user, session: s.session };
  } catch {
    return { kind: "unavailable" };
  }
}

export function parkedFrom(user: User, rt: string, now = Math.floor(Date.now() / 1000)): ParkedAccount {
  return { uid: user.id, email: user.email ?? null, name: profileName(user.user_metadata), rt, iat: now, nonce: newNonce() };
}

function stateless(accessToken?: string) {
  return createStatelessClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

export type RefreshResult =
  | { kind: "ok"; session: Session; user: User }
  /** The auth server refused the refresh token for good (revoked, expired, used): the row reads "Sign in again". */
  | { kind: "expired" }
  /** The auth server could not be asked, or asked to wait (a rate limit, a timeout, an outage): nothing is marked. */
  | { kind: "unavailable" };

/** A fresh session for a stored refresh token, from the auth server. The refresh token rotates: the old one is spent. */
export async function refreshParked(rt: string): Promise<RefreshResult> {
  if (!isSupabaseConfigured) return { kind: "unavailable" };
  try {
    const { data, error } = await stateless().auth.refreshSession({ refresh_token: rt });
    if (error) return refusedForGood(statusOf(error)) ? { kind: "expired" } : { kind: "unavailable" };
    if (!data.session || !data.user) return { kind: "unavailable" };
    return { kind: "ok", session: data.session, user: data.user };
  } catch {
    return { kind: "unavailable" };
  }
}

/** Ends one session at the auth server (its own scope only). True only when the auth server said it is over. */
async function endSession(session: Session): Promise<boolean> {
  try {
    const client = stateless();
    const set = await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
    if (set.error) return false;
    const out = await client.auth.signOut({ scope: "local" });
    return !out.error;
  } catch {
    return false;
  }
}

export type RevokeResult =
  /** The auth server ended the session. */
  | "revoked"
  /** The auth server had already refused it: nothing left to end. */
  | "already_over"
  /** The auth server could not be reached: the session may still be live there. Said to the person, never hidden. */
  | "not_revoked";

/** Ends a stored session at the auth server before its cookie goes, and says how far it got. */
export async function revokeParked(rt: string): Promise<RevokeResult> {
  const fresh = await refreshParked(rt);
  if (fresh.kind === "expired") return "already_over";
  if (fresh.kind === "unavailable") return "not_revoked";
  return (await endSession(fresh.session)) ? "revoked" : "not_revoked";
}

/** Ends a session the route has just been handed (one it will not keep). Best-effort, and said nowhere: it was never shown. */
export async function discardSession(session: Session): Promise<void> {
  await endSession(session);
}

/** Makes `session` the active Supabase session: the ordinary auth cookies, written by the same SSR client the app uses. */
export async function activate(session: Session): Promise<boolean> {
  const supabase = await createClient();
  if (!supabase) return false;
  try {
    const { error } = await supabase.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
    return !error;
  } catch {
    return false;
  }
}

/** The Supabase auth cookie, its chunks, and its PKCE verifier (`sb-<ref>-auth-token`, `.0`, `-code-verifier`). */
export const AUTH_COOKIE = /^sb-.+-auth-token(?:\.\d+|-code-verifier)?$/;

/** Removes the active session's cookies WITHOUT ending it at the auth server (it has just been parked). */
export async function clearActiveCookies(): Promise<void> {
  const store = await cookies();
  for (const c of store.getAll()) if (AUTH_COOKIE.test(c.name)) store.set(c.name, "", { path: "/", maxAge: 0 });
}

/**
 * The remembered channel and organization belong to the account being left: reset them, so the next account's first URL
 * never carries the previous account's channel name (as switching organization already does, app/api/org/switch).
 */
export async function resetWorkspaceCookies(): Promise<void> {
  const store = await cookies();
  store.set(CHANNEL_COOKIE, ALL_CHANNELS_SLUG, { path: "/", maxAge: 31536000, sameSite: "lax" });
  store.set(ORG_COOKIE, "", { path: "/", maxAge: 0 });
}

/** The access token's `aal` claim. The token came from the auth server a moment ago, so it is read, not verified, here. */
export function sessionAal(session: Session): string | null {
  try {
    const payload = JSON.parse(Buffer.from(session.access_token.split(".")[1] ?? "", "base64url").toString("utf8")) as { aal?: unknown };
    return typeof payload.aal === "string" ? payload.aal : null;
  } catch {
    return null;
  }
}

/**
 * Where a switch lands: that account's Home, or the code page FOR THAT ACCOUNT when its session is password-only and it has
 * an authenticator. Each account keeps its own second factor; one account's code never covers another.
 */
export function landingAfterSwitch(session: Session, user: User): string {
  const home = `/${ALL_CHANNELS_SLUG}`;
  if (sessionAal(session) !== "aal2" && hasVerifiedTotpFactor(user)) return mfaVerifyUrl(home);
  return home;
}

/**
 * The audit row, as the account now active, through the database's own function (audit_account_switch): it takes the
 * account switched FROM and records the caller as the one switched TO, so the browser can name neither. Ids only. When the
 * row cannot be written (the function's migration not applied yet, a refusal, an outage) the switch has still happened, and
 * the failure is logged here with its reason, never swallowed.
 */
export async function auditSwitch(session: Session, from: string | null): Promise<boolean> {
  try {
    const { error } = await stateless(session.access_token).rpc("audit_account_switch", { p_from: from });
    if (error) {
      console.error(`account.switch audit not written: ${error.code ?? "error"} ${error.message ?? ""}`.trim());
      return false;
    }
    return true;
  } catch (e) {
    console.error(`account.switch audit not written: ${e instanceof Error ? e.message : "unknown"}`);
    return false;
  }
}
