import { requireSameOrigin } from "@/lib/server/same-origin";
import { handleOwnerPost } from "@/lib/server/owner-rpc";
import { parseTeam } from "@/lib/owner-rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Add a person, change a role or remove a person: owner_add_member / owner_set_member_role / owner_remove_member.
 * The database refuses to leave no owner, to change yourself, and lets only an owner touch an admin or an owner.
 *
 * Behind NIGHTSHIFT_OWNER_RPC (404 while it is off). Same-origin, signed in, owner/admin, then ONE database
 * function called as the signed-in user (lib/server/owner-rpc.ts).
 */
export const POST = requireSameOrigin(async (request: Request) => handleOwnerPost(request, parseTeam));
