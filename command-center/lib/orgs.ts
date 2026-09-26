/**
 * Organizations — the tenant boundary (migration 0018).
 *
 * Pure and client-safe: types, the cookie name, and the decisions that are
 * worth unit-testing (which org a request is about, who may change whom). The
 * server half that reads cookies and calls Supabase is lib/orgs-server.ts.
 *
 * What the database decides and what this file decides are different things.
 * RLS decides which organizations' rows a user can read at all; this file only
 * decides which of those organizations the dashboard is looking at right now,
 * and mirrors the database's role rules so the UI never offers a control the
 * database would refuse.
 */

import { RANK, type Role, ROLES } from "@/lib/auth/roles-shared";

/** Remembers the organization last opened. A memory, validated on every
 *  request against the caller's memberships — never trusted on its own. */
export const ORG_COOKIE = "nightshift_org";

/** The organization every pre-0018 channel was backfilled into. Fixed in the
 *  migration so the pipeline and the dashboard can name it without a lookup. */
export const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";

export const ORG_NAME_MIN = 2;
export const ORG_NAME_MAX = 80;

/** One row of `my_organizations()`: an org the caller can open, and their role in it. */
export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
  is_default: boolean;
}

/** One row of `org_members`. */
export interface OrgMember {
  id: string;
  org_id: string;
  user_id: string | null;
  email: string;
  role: Role;
  created_at: string;
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as string[]).includes(value);
}

/**
 * Validate what the RPC returned. A row without an id, or with a role the app
 * does not know, is dropped rather than coerced: guessing "viewer" for an
 * unknown role would show an organization the database may not actually let
 * this user into.
 */
export function coerceOrgs(data: unknown): OrgSummary[] {
  if (!Array.isArray(data)) return [];
  const out: OrgSummary[] = [];
  const seen = new Set<string>();
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id || seen.has(r.id)) continue;
    if (!isRole(r.role)) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      name: typeof r.name === "string" && r.name ? r.name : r.id,
      slug: typeof r.slug === "string" ? r.slug : "",
      role: r.role,
      is_default: r.is_default === true,
    });
  }
  return out;
}

/**
 * Which organization this request is about.
 *
 * The remembered choice wins only if the caller is still a member of it — a
 * cookie naming an org they were removed from, or one they never belonged to,
 * is ignored rather than obeyed. Otherwise the default org (so the operator
 * lands exactly where they always did), otherwise the first org they belong to.
 * Null only when they belong to none, which is the "create your organization"
 * state.
 */
export function resolveCurrentOrg(
  remembered: string | undefined | null,
  orgs: OrgSummary[],
): OrgSummary | null {
  if (orgs.length === 0) return null;
  const chosen = remembered ? orgs.find((o) => o.id === remembered) : undefined;
  if (chosen) return chosen;
  return orgs.find((o) => o.is_default) ?? orgs[0];
}

/** Trimmed name when it is acceptable, else null. Mirrors create_organization(). */
export function validateOrgName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed.length >= ORG_NAME_MIN && trimmed.length <= ORG_NAME_MAX ? trimmed : null;
}

/** Owner/admin manage an org's members; editor and viewer do not. */
export function canManageMembers(myRole: Role): boolean {
  return RANK[myRole] >= RANK.admin;
}

/**
 * May `myRole` change or remove a member who currently holds `targetRole`?
 * Admin+ manages members, and only an owner may touch an owner — the rule the
 * org_members policies enforce.
 */
export function canEditMember(myRole: Role, targetRole: Role): boolean {
  if (!canManageMembers(myRole)) return false;
  return targetRole !== "owner" || myRole === "owner";
}

/** The roles `myRole` may grant. Only an owner may grant owner. */
export function assignableRoles(myRole: Role): Role[] {
  if (!canManageMembers(myRole)) return [];
  return ROLES.filter((r) => r !== "owner" || myRole === "owner");
}

/**
 * Would this change leave the org without an owner? The database refuses it
 * (org_members_keep_owner); the UI asks first so the refusal is explained
 * rather than surfaced as a generic save error.
 */
export function wouldRemoveLastOwner(
  members: Pick<OrgMember, "id" | "role">[],
  memberId: string,
  nextRole: Role | null,
): boolean {
  const target = members.find((m) => m.id === memberId);
  if (!target || target.role !== "owner") return false;
  if (nextRole === "owner") return false;
  return !members.some((m) => m.id !== memberId && m.role === "owner");
}

/**
 * Did an RPC fail because migration 0018 is not applied yet? PostgREST says
 * PGRST202 when a function is not in its schema cache; Postgres itself says
 * 42883. That is "organizations are not here yet" — the app then behaves
 * exactly as it did before 0018 — not a failure to report as broken.
 */
export function isMissingFunction(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /could not find the function|function .* does not exist/i.test(error.message ?? "");
}

/** A loose shape check before an invite round-trips to the database. */
export function isPlausibleEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
}
