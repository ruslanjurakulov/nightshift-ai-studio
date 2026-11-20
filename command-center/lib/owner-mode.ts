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

/** On unless the operator switched it off: the console is what the owner has always landed on. */
export function ownerFrame(operator: boolean, cookie: string | undefined): boolean {
  return operator && cookie !== "off";
}
