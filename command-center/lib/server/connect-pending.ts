import "server-only";
import { createHash, randomBytes } from "crypto";
import type { TokenExchange } from "@/lib/server/google-oauth";
import type { SocialProfile } from "@/lib/server/social-oauth";
import type { SocialPlatform } from "@/lib/social-accounts";
import type { YoutubeCandidate } from "@/lib/connect-picker";

/**
 * The OAuth result between the consent screen and the person's pick.
 *
 * After consent the callback holds a token and has to wait for a human to
 * choose which account to attach it to. That wait must not put the token in
 * the browser — not in a URL, a form field, local storage, or a cookie, even
 * an encrypted one (a copied cookie would replay). So the token stays HERE, in
 * the server process's memory, and the browser gets only an opaque random
 * handle in an httpOnly cookie.
 *
 * A record is:
 * - short-lived: ten minutes, then gone (swept on every touch);
 * - bound to the signed-in user AND to the organization being viewed: another
 *   user holding the handle, or the same user after switching organization,
 *   reads nothing;
 * - single-use: a successful confirm consumes it, and a confirm in flight
 *   cannot be started twice (two taps, two tabs);
 * - held under the SHA-256 of the handle, so a memory dump or a log of the map
 *   keys is not a list of working handles;
 * - bounded: a fixed number of records, oldest evicted first, one per user.
 *
 * It is a process-local Map, deliberately: no table (so no migration to apply
 * to the live database) and no key to configure. The cost is honest and safe:
 * a restart, or a second server replica answering the pick, finds no record
 * and the person sees "this took too long, connect again" — never a wrong
 * account. The deployment is one container behind Caddy (deploy/); a
 * multi-replica deployment would need sticky routing for /api/connect and the
 * pick page, or a shared store behind this same interface.
 *
 * Nothing in this file logs, and nothing returns a token to a caller that did
 * not just put it there: the pick page is given `view` data built from the
 * candidates, never the grant.
 */

export const PENDING_COOKIE = "__Host-ns_connect_pending";
export const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_RECORDS = 200;
const HANDLE_RE = /^[A-Za-z0-9_-]{43}$/;

export interface YoutubeGrant {
  platform: "youtube";
  /** Where the token will be kept (lib/channel-tokens.ts decideTokenStore). */
  store: "vault" | "github";
  tokens: TokenExchange;
  scopes: string[];
  candidates: YoutubeCandidate[];
  niche: string | null;
  language: string | null;
}

export interface SocialGrant {
  platform: SocialPlatform;
  accessToken: string;
  refreshToken: string | null;
  accessExpiresIn: number | null;
  refreshExpiresIn: number | null;
  scopes: string[];
  profile: SocialProfile;
}

export type PendingGrant = YoutubeGrant | SocialGrant;

interface Entry {
  userId: string;
  orgId: string;
  expiresAt: number;
  busy: boolean;
  grant: PendingGrant;
}

const KEY = Symbol.for("nightshift.connect.pending");

/** One Map per process, shared by the route handlers and the pick page (Next
 *  can bundle those separately, so a module-level Map would be several). */
function records(): Map<string, Entry> {
  const g = globalThis as unknown as Record<symbol, Map<string, Entry> | undefined>;
  return (g[KEY] ??= new Map());
}

function keyOf(handle: string): string {
  return createHash("sha256").update(handle).digest("hex");
}

function sweep(now: number): void {
  const map = records();
  for (const [k, e] of map) if (e.expiresAt <= now) map.delete(k);
}

/** Store a grant for this user and organization; returns the opaque handle. */
export function createPending(opts: {
  userId: string;
  orgId: string;
  grant: PendingGrant;
  now?: number;
}): string {
  const now = opts.now ?? Date.now();
  sweep(now);
  const map = records();
  // One pending connect per user: a new one replaces the old, whose token is dropped.
  for (const [k, e] of map) if (e.userId === opts.userId) map.delete(k);
  while (map.size >= MAX_RECORDS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  const handle = randomBytes(32).toString("base64url");
  map.set(keyOf(handle), {
    userId: opts.userId,
    orgId: opts.orgId,
    expiresAt: now + PENDING_TTL_MS,
    busy: false,
    grant: opts.grant,
  });
  return handle;
}

export interface PendingRead {
  grant: PendingGrant;
  orgId: string;
  expiresAt: number;
}

/** Look a record up for this user in this organization; null for anything else. */
export function readPending(
  handle: string | null | undefined,
  who: { userId: string; orgId: string | null },
  now: number = Date.now(),
): PendingRead | null {
  if (!handle || !HANDLE_RE.test(handle) || !who.orgId) return null;
  sweep(now);
  const e = records().get(keyOf(handle));
  if (!e || e.userId !== who.userId || e.orgId !== who.orgId) return null;
  return { grant: e.grant, orgId: e.orgId, expiresAt: e.expiresAt };
}

/**
 * Take the record for a confirm. Returns null when it is missing, not this
 * user's, in another organization, expired — or already being confirmed. The
 * caller must then call finishPending (success) or releasePending (a failure
 * the person may retry).
 */
export function claimPending(
  handle: string | null | undefined,
  who: { userId: string; orgId: string | null },
  now: number = Date.now(),
): PendingRead | null {
  const read = readPending(handle, who, now);
  if (!read || !handle) return null;
  const e = records().get(keyOf(handle));
  if (!e || e.busy) return null;
  e.busy = true;
  return read;
}

/** The confirm succeeded or can never succeed: the record (and its token) is gone. */
export function finishPending(handle: string): void {
  records().delete(keyOf(handle));
}

/** The confirm failed in a way worth retrying: the record stays for another try. */
export function releasePending(handle: string): void {
  const e = records().get(keyOf(handle));
  if (e) e.busy = false;
}

/** Forget whatever this user has pending (cancel, or a fresh start). */
export function dropUserPending(userId: string): void {
  const map = records();
  for (const [k, e] of map) if (e.userId === userId) map.delete(k);
}

/** For tests: how many records are held. */
export function pendingCount(): number {
  return records().size;
}

/** The handle from a request's Cookie header. */
export function pendingHandleFrom(request: Request): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${PENDING_COOKIE}=`))
    ?.slice(PENDING_COOKIE.length + 1);
}

export const pendingCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: Math.floor(PENDING_TTL_MS / 1000),
};
