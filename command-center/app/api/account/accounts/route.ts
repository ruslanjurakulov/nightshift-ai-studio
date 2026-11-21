import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getUser } from "@/lib/supabase/server";
import { accountsView, readParked } from "@/lib/server/device-accounts";

export const dynamic = "force-dynamic";

/**
 * GET: the accounts kept in this browser, as the avatar menu and the sign-in page draw them (lib/device-accounts.ts). Only
 * what this browser's own cookies hold, masked: an initial, a masked email, a name, whether the stored session was refused.
 * No token and no full address leaves the server. Signed out it lists the parked accounts, so the sign-in page can offer
 * "continue as" (the middleware lets this path through; each route decides for itself).
 */
export async function GET() {
  const active = await getUser();
  const parked = readParked(await cookies());
  return NextResponse.json(accountsView(active, parked), { headers: { "cache-control": "no-store" } });
}
