import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { isParkedSlot } from "@/lib/device-accounts";
import {
  activate,
  activeSession,
  auditSwitch,
  landingAfterSwitch,
  parkedFrom,
  readParked,
  refreshParked,
  writeParked,
} from "@/lib/server/device-accounts";
import { NO_STORE, fail, readBody } from "@/lib/server/device-accounts-http";

export const dynamic = "force-dynamic";

/**
 * POST { slot } — make a parked account the active one (lib/device-accounts.ts). The browser names a SLOT, never a user:
 * the account is whatever the auth server returns for that slot's stored refresh token, and it must be the account the slot
 * was parked as, or the switch is refused (a tampered or planted cookie). The account that was active is parked in the slot
 * it frees, so nothing is signed out. The answer names where to go, and the browser loads it in full (no router or RSC
 * cache of the previous account survives): that account's Home, or its own code page when its session is password-only and
 * it has an authenticator.
 *
 * - 400 not a slot; 404 nothing parked there.
 * - 409 session_expired: the auth server refused the stored session. The row is kept and reads "Sign in again"; no other
 *   account is switched to in its place.
 * - 409 account_mismatch: the session belongs to someone else than the slot says. The slot is dropped.
 * - 503 auth_unavailable: the auth server could not be asked. Nothing changed; try again.
 */
export const POST = requireSameOrigin(async (request: Request) => {
  const body = await readBody(request);
  const slot = body?.slot;
  if (!isParkedSlot(slot)) return fail("invalid_slot", 400);

  const parked = readParked(await cookies());
  const target = parked.get(slot);
  if (!target) return fail("unknown_slot", 404);

  const active = await activeSession();
  // Already the account in use (a stale duplicate): there is nothing to switch to.
  if (active && active.user.id === target.uid) {
    await writeParked(slot, null);
    return NextResponse.json({ to: "/" }, { headers: NO_STORE });
  }

  const fresh = await refreshParked(target.rt);
  if (fresh.kind === "unavailable") return fail("auth_unavailable", 503);
  if (fresh.kind === "expired") {
    await writeParked(slot, { ...target, stale: true });
    return fail("session_expired", 409);
  }
  if (fresh.user.id !== target.uid) {
    await writeParked(slot, null);
    return fail("account_mismatch", 409);
  }

  if (!(await activate(fresh.session))) {
    // The stored token has rotated: keep the new one, so the account stays parked and can be tried again.
    await writeParked(slot, { ...target, rt: fresh.session.refresh_token });
    return fail("auth_unavailable", 503);
  }
  // The account that was active takes the freed slot; a second copy of the new active account is removed.
  await writeParked(slot, active ? parkedFrom(active.user, active.session) : null);
  for (const [other, p] of parked) if (other !== slot && p.uid === fresh.user.id) await writeParked(other, null);

  await auditSwitch(fresh.session, active?.user.id ?? null, fresh.user.id);
  return NextResponse.json({ to: landingAfterSwitch(fresh.session, fresh.user) }, { headers: NO_STORE });
});
