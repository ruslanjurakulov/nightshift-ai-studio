import "server-only";
import { createClient, getUser } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { isChannelInCurrentOrg } from "@/lib/channels-server";
import { atLeast, resolveRole, type Role } from "@/lib/auth/roles";

/**
 * Role checks for actions that belong to an ORGANIZATION (migration 0018).
 *
 * `requireRole` (roles.ts) asks for the caller's PLATFORM role — their
 * app_members row. That is right for anything that spends the operator's own
 * resources (GitHub secrets, provider keys and top-ups, the price list), and
 * wrong for an action on a customer's own channel: the admin of a customer
 * organization has no platform role at all, yet RLS already lets them do the
 * thing. This file answers the other question — "what is the caller's role in
 * the organization that owns this channel?" — with the database's own answer.
 *
 * Where the answer comes from:
 * - The role is `my_organizations()`'s `role` column for the organization
 *   being viewed, which is `org_role()` — itself `is_org_member()` over
 *   `accessible_org_ids()`. So a platform owner/admin is owner/admin in every
 *   organization, and any platform role counts in the default organization,
 *   exactly as the RLS policies already treat them. Nothing here widens that.
 * - The target must be IN the organization being viewed: the channel via the
 *   same guard the routes already use (isChannelInCurrentOrg, #227), the org
 *   by id. Another organization's channel is "not found", never "forbidden":
 *   an admin of org A learns nothing about org B's channel ids, and a platform
 *   admin acts on B only after switching to it.
 *
 * Before 0018 there are no organizations: the check is today's `requireRole`,
 * unchanged. If 0018 IS there but the membership lookup failed for another
 * reason, the check fails closed (503) — falling back to the platform role
 * there would hand a customer's admin the pre-0018 answer, which for an RPC
 * error is the all-admin default.
 */

export type OrgTarget = { channelId: string | null | undefined } | { orgId: string | null | undefined };

export type OrgRoleSource = "org" | "platform";

export type OrgRoleCheck =
  | {
      ok: true;
      role: Role;
      /** The organization the role was read in; null before 0018. */
      orgId: string | null;
      /** "platform" only on the pre-0018 fallback. */
      source: OrgRoleSource;
    }
  | {
      ok: false;
      status: 401 | 403 | 404 | 503;
      error: "unauthorized" | "forbidden" | "not_found" | "org_unavailable";
    };

/**
 * The caller's role for an action on `target`, when it meets `min`.
 *
 * Order matters and is deliberate: signed in (401), then the target is in the
 * organization being viewed (404), then the role (403). A viewer of org A gets
 * 403 on A's channel; an admin of org B gets 404 on it.
 */
export async function requireOrgRole(target: OrgTarget, min: Role): Promise<OrgRoleCheck> {
  const user = await getUser();
  if (!user) return { ok: false, status: 401, error: "unauthorized" };

  const org = await getOrgContext();

  if (!org.supported) {
    if (org.unavailable) return { ok: false, status: 503, error: "org_unavailable" };
    // Pre-0018: exactly what the route did before — the platform role, and a
    // channel guard that lets every channel through (there is no tenant yet).
    if ("channelId" in target && !(await isChannelInCurrentOrg(target.channelId)))
      return { ok: false, status: 404, error: "not_found" };
    const role = await resolveRole();
    return atLeast(role, min)
      ? { ok: true, role, orgId: null, source: "platform" }
      : { ok: false, status: 403, error: "forbidden" };
  }

  const current = org.current;
  const inOrg =
    "channelId" in target
      ? await isChannelInCurrentOrg(target.channelId)
      : Boolean(current && target.orgId && target.orgId === current.id);
  if (!current || !inOrg) return { ok: false, status: 404, error: "not_found" };

  return atLeast(current.role, min)
    ? { ok: true, role: current.role, orgId: current.id, source: "org" }
    : { ok: false, status: 403, error: "forbidden" };
}

/**
 * The caller's role in the organization being viewed, for deciding which
 * buttons a page shows. Presentation only — every route re-checks with
 * requireOrgRole and RLS checks again. Pre-0018 it is the platform role, as
 * before; with 0018 and no organization (or a failed lookup) it is 'viewer',
 * so a page never offers an action the route would refuse.
 */
export async function resolveCurrentOrgRole(): Promise<Role> {
  const org = await getOrgContext();
  if (!org.supported) return org.unavailable ? "viewer" : resolveRole();
  return org.current?.role ?? "viewer";
}

/**
 * Is the caller a platform owner/admin (migration 0018's is_platform_admin)?
 * False on any error, and before 0018 — callers use it only to ALLOW
 * something extra, so an unknown must read as no.
 */
export async function isPlatformAdmin(): Promise<boolean> {
  const supabase = await createClient();
  if (!supabase) return false;
  try {
    const { data, error } = await supabase.rpc("is_platform_admin");
    return !error && data === true;
  } catch {
    return false;
  }
}
