/**
 * Owner mode: whether the platform operator sees their console (every owner and ops section) or the customer's app.
 *
 * The cookie is a viewing preference, never a permission. It is read only after the server has decided that this
 * person IS the operator (lib/auth/org-roles operatorLookup); for anyone else it is ignored, so a customer who sets
 * it by hand gets exactly the customer's frame they had. And it only changes how the app is drawn: the operator's
 * URLs keep working in either mode (the layout's redirects still use the real role), and every route and RLS policy
 * still decides what may be read or written.
 */
export const OWNER_MODE_COOKIE = "ns_owner_mode";

/** The Owner account's home: the platform owner's console (app/owner). A reserved root segment, never a channel. */
export const OWNER_CONSOLE = "/owner";

/**
 * On unless the platform OWNER switched it off: the console is what the owner has always landed on. Only the owner has a
 * User account to switch to; an admin who is not the owner (or whose owner answer could not be read) is always drawn as
 * the operator, so an `off` cookie left by the old owner-mode toggle (which every operator had) can never strand an admin
 * in the customer's frame with no switch to come back.
 */
export function ownerFrame(operator: boolean, cookie: string | undefined, platformOwner = false): boolean {
  if (!operator) return false;
  return platformOwner ? cookie !== "off" : true;
}
