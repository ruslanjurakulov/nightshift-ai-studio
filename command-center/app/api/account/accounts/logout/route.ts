import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { isNonce, isParkedSlot } from "@/lib/device-accounts";
import { readParked, revokeParked, writeParked } from "@/lib/server/device-accounts";
import { NO_STORE, fail, readBody } from "@/lib/server/device-accounts-http";

export const dynamic = "force-dynamic";

/**
 * POST { slot, nonce } — sign a PARKED account out of this browser: its session is ended at the auth server (its own scope)
 * and its cookie removed. The active account and the other parked one are not touched.
 * POST { all: true } — every parked account the same way; the browser then signs the active account out as it always has
 * (lib/sign-out.ts), so "Sign out of all accounts" leaves nothing behind.
 *
 * The cookie goes either way. When the auth server could not be reached, the answer says so (`revoked: false` /
 * `unrevoked`), and the menu tells the person the session was removed from this browser but may still be live there,
 * exactly as an ordinary sign-out does during an outage (lib/sign-out.ts "cleared"). Never a quiet success.
 *
 * Signing the ACTIVE account out is the ordinary sign-out, which never switches to another account by itself: the person
 * lands on the sign-in page, which offers the accounts still kept here.
 */
export const POST = requireSameOrigin(async (request: Request) => {
  const body = await readBody(request);
  if (!body) return fail("invalid_body", 400);
  const parked = readParked(await cookies());

  if (body.all === true) {
    let unrevoked = 0;
    for (const [slot, p] of parked) {
      if ((await revokeParked(p.rt)) === "not_revoked") unrevoked += 1;
      await writeParked(slot, null);
    }
    return NextResponse.json({ ok: true, unrevoked }, { headers: NO_STORE });
  }

  const slot = body.slot;
  if (!isParkedSlot(slot) || !isNonce(body.nonce)) return fail("invalid_slot", 400);
  const target = parked.get(slot);
  if (!target) return fail("unknown_slot", 404);
  if (target.nonce !== body.nonce) return fail("slot_changed", 409);
  const revoked = (await revokeParked(target.rt)) !== "not_revoked";
  await writeParked(slot, null);
  return NextResponse.json({ ok: true, revoked }, { headers: NO_STORE });
});
