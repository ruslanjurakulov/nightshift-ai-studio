import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { ADD_ACCOUNT_LOGIN, isNonce, isParkedSlot } from "@/lib/device-accounts";
import {
  activeSession,
  clearActiveCookies,
  freeSlot,
  parkedFrom,
  readParked,
  refreshParked,
  resetWorkspaceCookies,
  revokeParked,
  writeParked,
} from "@/lib/server/device-accounts";
import { NO_STORE, fail, readBody } from "@/lib/server/device-accounts-http";

export const dynamic = "force-dynamic";

/**
 * POST { replace?: slot, nonce? } — "Add account" (and "Sign in again" on a row whose session was refused, which names that
 * row and its nonce). The active account is PARKED, not signed out: its session, refreshed here so the parked copy is the
 * newest, moves to an httpOnly slot, and the active auth cookies are cleared without ending it at the auth server. The
 * browser then goes to the ordinary sign-in page, so the new account signs in exactly as anyone does: password, magic link
 * or Google, and its own second factor. Nothing is skipped.
 *
 * - 401 no account is signed in (the sign-in page is already the way to add one).
 * - 409 account_limit: this browser already holds the most accounts it may (lib/device-accounts MAX_DEVICE_ACCOUNTS).
 * - 409 slot_changed: the row to replace is not the one the list showed.
 * - 503 auth_unavailable: the auth server could not be asked; nothing was parked or cleared.
 */
export const POST = requireSameOrigin(async (request: Request) => {
  const body = await readBody(request);
  if (!body) return fail("invalid_body", 400);
  const replace = body.replace;
  if (replace !== undefined && (!isParkedSlot(replace) || !isNonce(body.nonce))) return fail("invalid_slot", 400);

  const active = await activeSession();
  if (active.kind === "unavailable") return fail("auth_unavailable", 503);
  if (active.kind === "none") return fail("unauthorized", 401);

  const parked = readParked(await cookies());
  // "Sign in again" frees the refused row's place; only that row, and only a refused one, can be replaced this way.
  if (replace !== undefined) {
    const row = parked.get(replace);
    if (!row || row.nonce !== body.nonce) return fail("slot_changed", 409);
    if (row.stale) {
      await writeParked(replace, null);
      parked.delete(replace);
    }
  }
  // An old copy of the active account is ended and its slot reused, rather than taking a second one.
  const own = [...parked].find(([, p]) => p.uid === active.user.id);
  let unrevoked = 0;
  if (own) {
    if ((await revokeParked(own[1].rt)) === "not_revoked") unrevoked += 1;
    parked.delete(own[0]);
  }
  const slot = own?.[0] ?? freeSlot(parked);
  if (!slot) return fail("account_limit", 409);

  const fresh = await refreshParked(active.session.refresh_token);
  if (fresh.kind === "unavailable") return fail("auth_unavailable", 503);
  // Refused for good: the active session is over anyway; it is kept as "Sign in again" rather than lost.
  const parkedNow = parkedFrom(active.user, fresh.kind === "ok" ? fresh.session.refresh_token : active.session.refresh_token);
  await writeParked(slot, fresh.kind === "ok" ? parkedNow : { ...parkedNow, stale: true });
  await clearActiveCookies();
  await resetWorkspaceCookies();
  return NextResponse.json({ to: ADD_ACCOUNT_LOGIN, unrevoked }, { headers: NO_STORE });
});
