import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { isParkedSlot } from "@/lib/device-accounts";
import { readParked, revokeParked, writeParked } from "@/lib/server/device-accounts";
import { NO_STORE, fail, readBody } from "@/lib/server/device-accounts-http";

export const dynamic = "force-dynamic";

/**
 * POST { slot } — sign a PARKED account out of this browser: its session is ended at the auth server (its own scope) and
 * its cookie removed. The active account and the other parked one are not touched.
 * POST { all: true } — every parked account the same way; the browser then signs the active account out as it always has
 * (lib/sign-out.ts), so "Log out of all" leaves nothing behind.
 *
 * Signing the ACTIVE account out is the ordinary sign-out, which never switches to another account by itself: the person
 * lands on the sign-in page, which offers the accounts still kept here.
 */
export const POST = requireSameOrigin(async (request: Request) => {
  const body = await readBody(request);
  if (!body) return fail("invalid_body", 400);
  const parked = readParked(await cookies());

  if (body.all === true) {
    for (const [slot, p] of parked) {
      if (!p.stale) await revokeParked(p.rt);
      await writeParked(slot, null);
    }
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }

  const slot = body.slot;
  if (!isParkedSlot(slot)) return fail("invalid_slot", 400);
  const target = parked.get(slot);
  if (!target) return fail("unknown_slot", 404);
  if (!target.stale) await revokeParked(target.rt);
  await writeParked(slot, null);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
});
