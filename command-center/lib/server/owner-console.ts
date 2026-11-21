import "server-only";
import { ownerAccess, type Access } from "@/lib/server/owner-analytics";

/**
 * The Owner Console's access answer for this request, for its pages (S8's) to read instead of asking again. It is the same
 * React-cached owner_analytics_is_owner() call app/owner/layout.tsx makes, so a page calling it costs no second RPC.
 *
 * By the time a page under /owner renders, the layout has already sent a signed-out caller to /login, a session that needs
 * the second factor to /login/verify, and everyone but the owner to the 404. A page still reads this rather than assuming,
 * so that it stays correct if it is ever rendered some other way; its own database reads keep their own checks.
 */
export async function ownerConsoleAccess(): Promise<Access> {
  return ownerAccess();
}
