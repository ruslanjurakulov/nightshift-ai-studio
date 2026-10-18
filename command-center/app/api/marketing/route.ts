import { requireSameOrigin } from "@/lib/server/same-origin";
import { handleOwnerPost } from "@/lib/server/owner-rpc";
import { marketingPostsOn } from "@/lib/server/marketing";
import { parseMarketing } from "@/lib/marketing-posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The owner's four moves on the brand channel's posts: edit the words, approve what you saw, reject with a reason, stop or
 * re-arm the poster: owner_marketing_edit / _approve / _reject / _kill (migration 0108).
 *
 * There is no action that sends, re-sends or tests a post. Approving only records the owner's yes; the worker posts it
 * later, and only while the poster is on, inside the weekly limit, with the hash the owner saw.
 *
 * Behind NIGHTSHIFT_MARKETING_POSTS (a same-origin POST gets 404 while it is not exactly `on`). The same checks, in the
 * same order, as /api/owner/*: same-origin, the switch, signed in, owner/admin, the second factor, a small JSON body,
 * then ONE database function called as the signed-in user (lib/server/owner-rpc.ts).
 */
export const POST = requireSameOrigin(async (request: Request) => handleOwnerPost(request, parseMarketing, marketingPostsOn));
