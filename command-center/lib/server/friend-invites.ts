import { cookies } from "next/headers";
import {
  INVITE_COOKIE,
  INVITE_COOKIE_MAX_AGE,
  coerceInviteAdmin,
  coerceMyInvite,
  normalizeInviteToken,
  type InviteAdmin,
  type MyInvite,
} from "@/lib/friend-invites";
import { isMissingFunction } from "@/lib/orgs";

/**
 * The server half of Invite friends (migration 0092).
 *
 * Nothing here decides who is paid: the database does (join_friend_invite,
 * friend_invite_pay_locked). This file only carries the token from the link to
 * the moment the new account's e-mail is confirmed, and says nothing about the
 * outcome to the browser — a new person is not told whether they "counted"
 * (they get nothing from it), and a dead link answers like a revoked one.
 */

/** The slice of a Supabase client these helpers use (the SSR client and test doubles both fit). */
export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export const INVITE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: INVITE_COOKIE_MAX_AGE,
};

/** A visitor's rate: one in-process window per address. Defence in depth only —
 *  the token's 128 bits are what make guessing pointless, and a serverless
 *  instance forgets this on restart. */
const hits = new Map<string, { start: number; count: number }>();
export const INVITE_VISIT_LIMIT = { max: 30, windowMs: 60_000 };

export function takeVisit(key: string, now = Date.now()): boolean {
  const start = Math.floor(now / INVITE_VISIT_LIMIT.windowMs) * INVITE_VISIT_LIMIT.windowMs;
  const cur = hits.get(key);
  const next = cur && cur.start === start ? { start, count: cur.count + 1 } : { start, count: 1 };
  hits.set(key, next);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.start !== start) hits.delete(k);
  }
  return next.count <= INVITE_VISIT_LIMIT.max;
}

/** The address a request came from, for the visit rate only. Never stored, never logged. */
export function visitorKey(headers: Headers): string {
  const forwarded = headers.get("x-vercel-forwarded-for") ?? headers.get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0]?.trim() || "unknown";
}

/** Is this link live? (anon-callable boolean, friend_invite_peek). Any failure is "no". */
export async function peekInvite(client: RpcClient, token: string): Promise<boolean> {
  try {
    const { data, error } = await client.rpc("friend_invite_peek", { p_token: token });
    return !error && data === true;
  } catch {
    return false;
  }
}

/**
 * The signed-in new account says it came through the link in its cookie. Called
 * once the e-mail is confirmed (the auth callback, or sign-up when the project
 * confirms nothing). Never throws and never changes the sign-in: a failure
 * here costs the link's owner one count, not the new person their account.
 * The cookie is always cleared — it is a one-shot.
 */
export async function joinFromCookie(client: RpcClient): Promise<void> {
  let jar: Awaited<ReturnType<typeof cookies>>;
  try {
    jar = await cookies();
  } catch {
    return;
  }
  const raw = jar.get(INVITE_COOKIE)?.value;
  if (!raw) return;
  try {
    const token = normalizeInviteToken(raw);
    if (!token) return;
    // A person's own allowance first (take_web_rate, 0042), so the route
    // cannot be driven in a loop from one session.
    const rate = await client.rpc("take_web_rate", { p_bucket: "invite.join", p_max: 10, p_window_seconds: 3600 });
    if (rate.error || rate.data !== true) return;
    await client.rpc("join_friend_invite", { p_token: token });
  } catch {
    /* the sign-in goes on */
  } finally {
    try {
      jar.set(INVITE_COOKIE, "", { path: "/", maxAge: 0 });
    } catch {
      /* a read-only cookie store: the cookie expires on its own */
    }
  }
}

/** ok / unsupported (migration 0092 not applied: the card is simply not shown) /
 *  failed (unknown: never a zero or an empty list in its place). */
export type InviteRead<T> = { state: "ok"; value: T } | { state: "unsupported" } | { state: "failed" };

async function readRpc<T>(
  client: RpcClient,
  fn: string,
  coerce: (raw: unknown) => T | null,
): Promise<InviteRead<T>> {
  try {
    const { data, error } = await client.rpc(fn);
    if (error) return isMissingFunction(error as { code?: string; message?: string }) ? { state: "unsupported" } : { state: "failed" };
    const value = coerce(data);
    return value ? { state: "ok", value } : { state: "failed" };
  } catch {
    return { state: "failed" };
  }
}

/** The signed-in person's own link and progress (RLS-free: the function reads auth.uid() itself). */
export function readMyInvite(client: RpcClient): Promise<InviteRead<MyInvite>> {
  return readRpc(client, "my_friend_invite", coerceMyInvite);
}

/** The operator's settings and counts; the database refuses anyone else. */
export function readInviteAdmin(client: RpcClient): Promise<InviteRead<InviteAdmin>> {
  return readRpc(client, "friend_invite_admin", coerceInviteAdmin);
}
