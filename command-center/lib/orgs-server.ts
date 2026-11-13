import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  ORG_COOKIE,
  coerceMemberOrgIds,
  coerceOrgs,
  isMissingFunction,
  membershipCanNarrow,
  organizationsAreExpected,
  resolveCurrentOrg,
  switchableOrgs,
  type OrgSummary,
} from "@/lib/orgs";

/**
 * The organization this request is about, resolved on the server.
 *
 * The cookie is only a memory of the org last opened. What the user may open
 * comes from `my_organizations()` (migration 0018), which asks the database —
 * membership rows, plus the operator's platform role — so a cookie naming an
 * org the caller does not belong to is simply ignored.
 *
 * `supported` is false when 0018 has not been applied: no organizations
 * exist, nothing is filtered by org, and the app renders exactly as before.
 * Any other failure also degrades to "not supported" rather than to "you
 * belong to nothing" — telling the operator to create an organization because
 * a network call failed would be the wrong remedy. Such a failure is marked
 * `unavailable`, so an org-role check (lib/auth/org-roles.ts) can tell "0018
 * is not here" (use the platform role, as before) from "0018 is here and the
 * lookup failed" (refuse — the platform-role fallback would be the wrong
 * answer for a customer's admin).
 *
 * Two lists, because "may read" and "is in" are different questions for the
 * platform operator. `orgs` is everything my_organizations() returns — for a
 * platform owner/admin that is every organization, the same answer RLS gives
 * (the /welcome redirect and canCarryRun read it). `switchable` is what the
 * header offers and what `current` is resolved from: the caller's own
 * memberships plus the default org (switchableOrgs, lib/orgs.ts). The org role
 * checks (requireOrgRole, resolveCurrentOrgRole in lib/auth/org-roles.ts) read
 * `current`, so they resolve against those same orgs: the operator cannot act
 * inside a customer's workspace from here. That is intended (owner decision,
 * 2026-11-13); support is read-only, through the Customers section. For
 * everyone who is not a platform admin the two lists are the same.
 *
 * Wrapped in React's cache() so the layout and the page share one resolution
 * per request.
 */
export interface OrgContext {
  supported: boolean;
  orgs: OrgSummary[];
  /** The orgs the switcher lists and `current` may be; see switchableOrgs. */
  switchable: OrgSummary[];
  current: OrgSummary | null;
  /** True when 0018 looks applied but the membership lookup failed. */
  unavailable?: boolean;
}

const UNSUPPORTED: OrgContext = { supported: false, orgs: [], switchable: [], current: null };
const UNAVAILABLE: OrgContext = { supported: false, orgs: [], switchable: [], current: null, unavailable: true };

/** switchableFor's answer: the list, and whether it is the fail-closed one because the membership read failed. */
export interface SwitchableOrgs {
  orgs: OrgSummary[];
  /** True when org_members could not be read and `orgs` is the default org alone (switchableOrgs with null). */
  membershipReadFailed: boolean;
}

/**
 * `orgs` narrowed to the ones the caller may switch into (switchableOrgs).
 *
 * Reads the caller's OWN bound rows of org_members. The select policy (0018)
 * lets a user read rows with `user_id = auth.uid()`, and also every row of an
 * org they can access — which for a platform admin is every row of every org,
 * so the user_id filter is what makes this "mine" and must stay. Only bound
 * rows count, as in accessible_org_ids since 0043: a pending invite is not
 * membership. Asked whenever `orgs` holds the default org and at least one
 * other (membershipCanNarrow) — the shape a platform role produces, even when
 * their memberships would leave the list as it is — so a customer, whose list
 * does not hold the default org, makes no extra request.
 * Never throws: a failed read is the default org alone with
 * `membershipReadFailed`, so a caller can say "could not check" (503) instead
 * of "not yours" (403).
 */
export async function switchableFor(
  supabase: SupabaseClient,
  userId: string,
  orgs: OrgSummary[],
): Promise<SwitchableOrgs> {
  if (!membershipCanNarrow(orgs)) return { orgs, membershipReadFailed: false };
  let memberIds: Set<string> | null = null;
  try {
    const { data, error } = await supabase.from("org_members").select("org_id").eq("user_id", userId);
    memberIds = error ? null : coerceMemberOrgIds(data);
  } catch {
    memberIds = null;
  }
  return { orgs: switchableOrgs(orgs, memberIds), membershipReadFailed: memberIds === null };
}

export const getOrgContext = cache(async (): Promise<OrgContext> => {
  const supabase = await createClient();
  if (!supabase) return UNSUPPORTED;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return UNSUPPORTED;

  try {
    // Nothing is bound here: a workspace has one person, who created it, and
    // there are no invitations to bind (migrations 0043 and 0091).
    const { data, error } = await supabase.rpc("my_organizations");
    // "Function missing" means "0018 is not here yet" only where that can be
    // true. In production it cannot, so it is a failure like any other and
    // fails closed (isOperator would otherwise read it as "every signed-in
    // account is the operator's team").
    if (error) return isMissingFunction(error) && !organizationsAreExpected() ? UNSUPPORTED : UNAVAILABLE;
    const orgs = coerceOrgs(data);
    const { orgs: switchable, membershipReadFailed } = await switchableFor(supabase, user.id, orgs);
    const remembered = (await cookies()).get(ORG_COOKIE)?.value;
    // The membership read failed and the remembered org is a non-default one
    // the caller can read: it may well be their own workspace, and resolving to
    // the default org would silently move every write of this request (anything
    // keyed on current.id) into another organization with nothing on screen.
    // UNAVAILABLE rather than a new flag, because every consumer already treats
    // it as "could not check": requireOrgRole answers 503 org_unavailable,
    // resolveCurrentOrgRole offers viewer only, and operatorLookup reports
    // `failed`, so the operator's pages show the could-not-check screen
    // (AccessError) rather than a workspace. With no cookie, a
    // default-org cookie, or one naming an org not in `orgs` (ignored even when
    // the read works), the default org is the same answer a good read gives.
    if (membershipReadFailed && orgs.some((o) => o.id === remembered && !o.is_default)) return UNAVAILABLE;
    // Resolved over `switchable`, not `orgs`: a cookie still naming a customer's
    // org the operator once opened is ignored, and they land on their own.
    return { supported: true, orgs, switchable, current: resolveCurrentOrg(remembered, switchable) };
  } catch {
    return UNAVAILABLE;
  }
});

/** Cookie options for the remembered org: a view preference, not a credential. */
export const ORG_COOKIE_OPTIONS = {
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
  sameSite: "lax" as const,
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
};
