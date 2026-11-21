import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { isNonce, isParkedSlot } from "@/lib/device-accounts";
import {
  activate,
  activeSession,
  auditSwitch,
  discardSession,
  landingAfterSwitch,
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
 * POST { slot, nonce } — make a parked account the active one (lib/device-accounts.ts). The browser names a SLOT and the
 * occupant it saw there (the nonce), never a user: the account is whatever the auth server returns for that slot's stored
 * refresh token, and it must be the account the slot was parked as, or the switch is refused (a tampered or planted
 * cookie). The account that was active is parked in the slot it frees, with a token refreshed here so the parked copy is
 * the newest, so nothing is signed out. The answer names where to go, and the browser loads it in full: that account's
 * Home, or its own code page when its session is password-only and it has an authenticator.
 *
 * - 400 not a slot or nonce; 404 nothing parked there.
 * - 409 slot_changed: another tab switched since this list was read; the browser reads the list again. Nothing changed.
 * - 409 session_expired: the auth server refused the stored session. The row is kept and reads "Sign in again"; no other
 *   account is switched to in its place.
 * - 409 account_mismatch: the session belongs to someone else than the slot says. It is ended and the slot dropped.
 * - 503 auth_unavailable: the auth server could not be asked (about either account). Nothing changed; try again.
 */
export const POST = requireSameOrigin(async (request: Request) => {
  const body = await readBody(request);
  const slot = body?.slot;
  if (!isParkedSlot(slot) || !isNonce(body?.nonce)) return fail("invalid_slot", 400);

  const parked = readParked(await cookies());
  const target = parked.get(slot);
  if (!target) return fail("unknown_slot", 404);
  if (target.nonce !== body.nonce) return fail("slot_changed", 409);

  // Who is active now must be KNOWN before anything is replaced: an outage is not "nobody", or that account would be lost.
  const active = await activeSession();
  if (active.kind === "unavailable") return fail("auth_unavailable", 503);
  if (active.kind === "ok" && active.user.id === target.uid) {
    // A leftover copy of the account already in use: its own session is ended, the copy removed, and nothing reloads.
    await revokeParked(target.rt);
    await writeParked(slot, null);
    return NextResponse.json({ same: true }, { headers: NO_STORE });
  }

  const fresh = await refreshParked(target.rt);
  if (fresh.kind === "unavailable") return fail("auth_unavailable", 503);
  if (fresh.kind === "expired") {
    await writeParked(slot, { ...target, stale: true });
    return fail("session_expired", 409);
  }
  if (fresh.user.id !== target.uid) {
    await discardSession(fresh.session);
    await writeParked(slot, null);
    return fail("account_mismatch", 409);
  }

  if (!(await activate(fresh.session))) {
    // The stored token has rotated: keep the new one, so the account stays parked and can be tried again.
    await writeParked(slot, { ...target, rt: fresh.session.refresh_token });
    return fail("auth_unavailable", 503);
  }
  // Only now, with the switch done, is the outgoing account's token refreshed for its parked copy (the newest one, not one a
  // tab may be about to spend). Refreshing it any earlier would spend the active cookie's token on a switch that might
  // still be refused, and the person would then be signed out of the account they stayed in.
  // A refusal for good keeps the row as "Sign in again"; an outage parks the token as it was (it was never spent).
  if (active.kind === "ok") {
    const outgoing = await refreshParked(active.session.refresh_token);
    const out = parkedFrom(active.user, outgoing.kind === "ok" ? outgoing.session.refresh_token : active.session.refresh_token);
    await writeParked(slot, outgoing.kind === "expired" ? { ...out, stale: true } : out);
  } else {
    await writeParked(slot, null);
  }
  // No account kept twice: other copies of either account are ended and removed.
  for (const [other, p] of parked) {
    if (other === slot) continue;
    if (p.uid === fresh.user.id || (active.kind === "ok" && p.uid === active.user.id)) {
      await revokeParked(p.rt);
      await writeParked(other, null);
    }
  }
  await resetWorkspaceCookies();
  await auditSwitch(fresh.session, active.kind === "ok" ? active.user.id : null);
  return NextResponse.json({ to: landingAfterSwitch(fresh.session, fresh.user) }, { headers: NO_STORE });
});
