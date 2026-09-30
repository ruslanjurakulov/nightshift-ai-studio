/**
 * Pending invitations (migration 0043): an invite is an offer the invitee
 * accepts or declines — it is not membership until then, and only an account
 * whose email address is confirmed sees the ones addressed to it.
 *
 * Client-safe: the rows come from `my_invites()` through the browser client,
 * and accepting / declining are `accept_org_invite` / `decline_org_invite`.
 * The database decides; this only shapes what it returned.
 */

export type PendingInvite = { id: string; orgId: string; orgName: string };

/** my_invites() rows → invites; anything malformed is dropped, not guessed. */
export function coerceInvites(data: unknown): PendingInvite[] {
  if (!Array.isArray(data)) return [];
  const out: PendingInvite[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.org_id !== "string") continue;
    out.push({ id: r.id, orgId: r.org_id, orgName: typeof r.org_name === "string" && r.org_name ? r.org_name : r.org_id });
  }
  return out;
}
