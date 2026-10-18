import { requireSameOrigin } from "@/lib/server/same-origin";
import { handleOwnerPost } from "@/lib/server/owner-rpc";
import { parseReverse } from "@/lib/owner-rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Take back (part of) an owner grant inside the reversal window: owner_reverse_grant(transaction, reason).
 * Bounded by what the grant's lot still holds; the rest is recorded as a shortfall. One reversal per grant.
 *
 * Behind NIGHTSHIFT_OWNER_RPC (404 while it is off). Same-origin, signed in, owner/admin, then ONE database
 * function called as the signed-in user (lib/server/owner-rpc.ts).
 */
export const POST = requireSameOrigin(async (request: Request) => handleOwnerPost(request, parseReverse));
