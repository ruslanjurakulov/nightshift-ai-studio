import { requireSameOrigin } from "@/lib/server/same-origin";
import { handleOwnerPost } from "@/lib/server/owner-rpc";
import { parseGrant } from "@/lib/owner-rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Give credits to an organization: owner_grant_credits(org, credits, reason, idempotency key). Capped per grant and
 * per rolling 24 hours, idempotent on the request key (a double tap adds once), audited.
 *
 * Behind NIGHTSHIFT_OWNER_RPC (404 while it is off). Same-origin, signed in, owner/admin, then ONE database
 * function called as the signed-in user (lib/server/owner-rpc.ts).
 */
export const POST = requireSameOrigin(async (request: Request) => handleOwnerPost(request, parseGrant));
