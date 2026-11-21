import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getUser } from "@/lib/supabase/server";
import { accountsView, malformedSlots, readParked, writeParked } from "@/lib/server/device-accounts";

export const dynamic = "force-dynamic";

/**
 * GET: the accounts kept in this browser, as the avatar menu and the sign-in page draw them (lib/device-accounts.ts). Only
 * what this browser's own cookies hold: an initial, a name, a masked email (the active account's own in full), whether the
 * stored session was refused, and each slot's nonce (a precondition, not a secret). No token leaves the server. Signed out
 * it lists the parked accounts, so the sign-in page can offer "continue as" (the middleware lets this path through).
 * A cookie that is not one of ours is removed here rather than left behind.
 */
export async function GET() {
  const store = await cookies();
  for (const slot of malformedSlots(store)) await writeParked(slot, null);
  const active = await getUser();
  return NextResponse.json(accountsView(active, readParked(store)), { headers: { "cache-control": "no-store" } });
}
