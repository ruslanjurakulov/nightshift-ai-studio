import "server-only";
import { notFound } from "next/navigation";
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

/**
 * Every Owner Console page's own lock, called first. Next can render a page segment without running the layout above it (a
 * soft navigation whose router state already holds /owner, a forged router-state header), so the layout's 404 is not a
 * lock on the page: each page asks again (the same cached answer, no second RPC) and answers the 404 to anyone but the
 * platform owner — a customer, an admin who is not the owner, a signed-out visitor, a check that could not be made.
 */
export async function requireOwnerConsole(): Promise<void> {
  if ((await ownerConsoleAccess()) !== "owner") notFound();
}
