import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { ADD_ACCOUNT_LOGIN, isParkedSlot } from "@/lib/device-accounts";
import { activeSession, clearActiveCookies, freeSlot, parkedFrom, readParked, writeParked } from "@/lib/server/device-accounts";
import { NO_STORE, fail, readBody } from "@/lib/server/device-accounts-http";

export const dynamic = "force-dynamic";

/**
 * POST { replace?: slot } — "Add account" (and "Sign in again" on a row whose session was refused, which names that row in
 * `replace`). The active account is PARKED, not signed out: its session moves to an httpOnly slot and the active auth
 * cookies are cleared without ending it at the auth server. The browser then goes to the ordinary sign-in page, so the new
 * account signs in exactly as anyone does: password, magic link or Google, and its own second factor. Nothing is skipped.
 *
 * - 401 no account is signed in (the sign-in page is already the way to add one).
 * - 409 account_limit: this browser already holds the most accounts it may (lib/device-accounts MAX_DEVICE_ACCOUNTS).
 */
export const POST = requireSameOrigin(async (request: Request) => {
  const body = await readBody(request);
  if (!body) return fail("invalid_body", 400);
  const replace = body.replace;
  if (replace !== undefined && !isParkedSlot(replace)) return fail("invalid_slot", 400);

  const active = await activeSession();
  if (!active) return fail("unauthorized", 401);

  const parked = readParked(await cookies());
  // "Sign in again" frees the refused row's place; only a refused one can be replaced this way.
  if (replace !== undefined && parked.get(replace)?.stale) {
    await writeParked(replace, null);
    parked.delete(replace);
  }
  // The active account already parked once (an old copy) reuses its own slot rather than taking a second one.
  const own = [...parked].find(([, p]) => p.uid === active.user.id)?.[0];
  const slot = own ?? freeSlot(parked);
  if (!slot) return fail("account_limit", 409);

  await writeParked(slot, parkedFrom(active.user, active.session));
  await clearActiveCookies();
  return NextResponse.json({ to: ADD_ACCOUNT_LOGIN }, { headers: NO_STORE });
});
