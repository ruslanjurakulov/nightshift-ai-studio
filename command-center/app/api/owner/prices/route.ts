import { requireSameOrigin } from "@/lib/server/same-origin";
import { handleOwnerPost } from "@/lib/server/owner-rpc";
import { parsePrice } from "@/lib/owner-rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Set, delete or restore a credit price: owner_set_credit_price / owner_delete_credit_price /
 * owner_restore_credit_price. A big change answers 409 `confirm_required` with the old and new figures and the ratio
 * until it is sent again with `confirm: true`.
 *
 * Behind NIGHTSHIFT_OWNER_RPC (a same-origin POST gets 404 while it is off). Same-origin, signed in, owner/admin, then ONE database
 * function called as the signed-in user (lib/server/owner-rpc.ts).
 */
export const POST = requireSameOrigin(async (request: Request) => handleOwnerPost(request, parsePrice));
