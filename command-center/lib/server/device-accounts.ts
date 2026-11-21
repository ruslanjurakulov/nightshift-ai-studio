import "server-only";
import { cookies } from "next/headers";
import { createClient as createStatelessClient, type Session, type User } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";
import { createClient } from "@/lib/supabase/server";
import { SESSION_COOKIE_MAX_AGE_SECONDS } from "@/lib/supabase/cookie-options";
import { hasVerifiedTotpFactor, mfaVerifyUrl } from "@/lib/security/admin-mfa";
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

export function encodeParked(p: ParkedAccount): string {
  const body = { v: VERSION, uid: p.uid, email: p.email, name: p.name, rt: p.rt, iat: p.iat, ...(p.stale ? { stale: true } : {}) };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

/** A parked account from its cookie, or null for anything malformed (which is then dropped, never acted on). */
export function decodeParked(value: string | undefined | null): ParkedAccount | null {
  if (!value || value.length > MAX_COOKIE_CHARS) return null;
  try {
    const p = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (p.v !== VERSION) return null;
    if (typeof p.uid !== "string" || !UUID.test(p.uid)) return null;
    if (typeof p.rt !== "string" || !p.rt || p.rt.length > 2048) return null;
    if (typeof p.iat !== "number" || !Number.isFinite(p.iat)) return null;
    const email = typeof p.email === "string" && p.email.length <= 320 ? p.email : null;
    const name = typeof p.name === "string" && p.name.length <= 80 ? p.name : null;
    return { uid: p.uid, email, name, rt: p.rt, iat: p.iat, ...(p.stale === true ? { stale: true as const } : {}) };
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

/** The first empty slot, or null when the device already holds the most accounts it may. */
export function freeSlot(parked: Map<ParkedSlot, ParkedAccount>): ParkedSlot | null {
  for (const slot of PARKED_SLOTS) if (!parked.has(slot)) return slot;
  return null;
}

/** The active account plus the parked ones, as the menu draws them. A parked copy of the active account is not listed twice. */
export function accountsView(active: User | null, parked: Map<ParkedSlot, ParkedAccount>): DeviceAccountsAnswer {
  const accounts: DeviceAccountView[] = [];
  if (active) {
    const name = profileName(active.user_metadata);
    accounts.push({ slot: null, current: true, name, maskedEmail: maskEmail(active.email), initial: accountInitial(name, active.email), stale: false });
  }
  for (const [slot, p] of parked) {
    if (active && p.uid === active.id) continue;
    accounts.push({ slot, current: false, name: p.name, maskedEmail: maskEmail(p.email), initial: accountInitial(p.name, p.email), stale: p.stale === true });
  }
  return { accounts, canAdd: accounts.length < MAX_DEVICE_ACCOUNTS };
}

/** Writes or removes one slot's cookie on this request's response. */
export async function writeParked(slot: ParkedSlot, p: ParkedAccount | null): Promise<void> {
  const store = await cookies();
  if (p) store.set(parkedCookieName(slot), encodeParked(p), parkedCookieOptions());
  else store.set(parkedCookieName(slot), "", { ...parkedCookieOptions(), maxAge: 0 });
}

/** The active account's own session as Supabase confirms it (getUser asks the auth server), or null. */
export async function activeSession(): Promise<{ user: User; session: Session } | null> {
  const supabase = await createClient();
  if (!supabase) return null;
  const { data: u, error } = await supabase.auth.getUser();
  if (error || !u.user) return null;
  const { data: s } = await supabase.auth.getSession();
  if (!s.session || !s.session.refresh_token) return null;
  return { user: u.user, session: s.session };
}

export function parkedFrom(user: User, session: Session, now = Math.floor(Date.now() / 1000)): ParkedAccount {
  return { uid: user.id, email: user.email ?? null, name: profileName(user.user_metadata), rt: session.refresh_token, iat: now };
}

function stateless(accessToken?: string) {
  return createStatelessClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

export type RefreshResult =
  | { kind: "ok"; session: Session; user: User }
  /** The auth server refused the refresh token (revoked, expired, used): the row reads "Sign in again". */
  | { kind: "expired" }
  /** The auth server could not be asked (offline, 5xx): nothing is marked, the person may retry. */
  | { kind: "unavailable" };

/** A fresh session for a parked account, from the auth server. The refresh token rotates: the old one is spent. */
export async function refreshParked(rt: string): Promise<RefreshResult> {
  if (!isSupabaseConfigured) return { kind: "unavailable" };
  try {
    const { data, error } = await stateless().auth.refreshSession({ refresh_token: rt });
    if (error) {
      const status = (error as { status?: number }).status;
      return typeof status === "number" && status >= 400 && status < 500 ? { kind: "expired" } : { kind: "unavailable" };
    }
    if (!data.session || !data.user) return { kind: "expired" };
    return { kind: "ok", session: data.session, user: data.user };
  } catch {
    return { kind: "unavailable" };
  }
}

/** Ends a parked session at the auth server (its own scope only). Best-effort: the cookie is removed either way. */
export async function revokeParked(rt: string): Promise<void> {
  const fresh = await refreshParked(rt);
  if (fresh.kind !== "ok") return;
  try {
    const client = stateless();
    await client.auth.setSession({ access_token: fresh.session.access_token, refresh_token: fresh.session.refresh_token });
    await client.auth.signOut({ scope: "local" });
  } catch {
    /* the cookie goes anyway; the session then lapses on its own */
  }
}

/** Makes `session` the active Supabase session: the ordinary auth cookies, written by the same SSR client the app uses. */
export async function activate(session: Session): Promise<boolean> {
  const supabase = await createClient();
  if (!supabase) return false;
  const { error } = await supabase.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  return !error;
}

const AUTH_COOKIE = /^sb-.+-auth-token(?:\.\d+)?$/;

/** Removes the active session's cookies WITHOUT ending it at the auth server (it has just been parked). */
export async function clearActiveCookies(): Promise<void> {
  const store = await cookies();
  for (const c of store.getAll()) if (AUTH_COOKIE.test(c.name)) store.set(c.name, "", { path: "/", maxAge: 0 });
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
  const home = "/";
  if (sessionAal(session) !== "aal2" && hasVerifiedTotpFactor(user)) return mfaVerifyUrl(home);
  return home;
}

/** The audit row (app_audit_log, migration 0008), as the account now active: ids only, never a token or an address. */
export async function auditSwitch(session: Session, from: string | null, to: string): Promise<void> {
  try {
    await stateless(session.access_token)
      .from("app_audit_log")
      .insert({ actor_user_id: to, actor_email: null, action: "account.switch", target: to, detail: { from, to }, channel_id: null });
  } catch {
    /* best-effort, as logAudit: the switch itself already happened */
  }
}
