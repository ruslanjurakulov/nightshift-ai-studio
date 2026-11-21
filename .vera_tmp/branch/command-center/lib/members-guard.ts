import type { Role } from "@/lib/auth/roles-shared";

/**
 * The Team page's last-owner guard (the app-layer half of backend finding B-05; the database half is a
 * migration and is NOT in this change).
 *
 * The page writes `app_members` straight from the browser, and RLS lets an owner change or delete ANY row,
 * including their own. With one owner and a couple of other rows, a tap on their own role menu or on "Remove"
 * would leave nobody who can administer the site (admins cannot edit an owner), and the way back is the SQL editor.
 * So the page does not offer it: a BOUND owner (a row with a user id; an invited address with no account yet
 * cannot administer anything) who is the only one cannot be demoted or removed from here.
 *
 * This is a convenience guard, not security: whoever writes the table directly bypasses it. It exists so the
 * owner cannot lock themselves out by accident.
 */
export interface MemberLike {
  id: string;
  user_id: string | null;
  role: Role;
}

/** True when changing `targetId` to `next` ("removed" = deleting the row) would leave no bound owner. */
export function wouldLeaveNoOwner(members: readonly MemberLike[], targetId: string, next: Role | "removed"): boolean {
  const target = members.find((m) => m.id === targetId);
  if (!target || target.role !== "owner" || !target.user_id) return false;
  if (next === "owner") return false;
  return !members.some((m) => m.id !== targetId && m.role === "owner" && m.user_id);
}
