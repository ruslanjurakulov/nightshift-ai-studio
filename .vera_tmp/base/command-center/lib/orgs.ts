/**
 * Organizations — the tenant boundary (migration 0018).
 *
 * Pure and client-safe: types, the cookie name, and the decisions that are
 * worth unit-testing (which org a request is about). The
 * server half that reads cookies and calls Supabase is lib/orgs-server.ts.
 *
 * What the database decides and what this file decides are different things.
 * RLS decides which organizations' rows a user can read at all; this file only
 * decides which of those organizations the dashboard is looking at right now.
 * There is no member management here: a workspace belongs to the person who
 * created it (migration 0091 closes every way to add a second person).
 */

import { type Role, ROLES } from "@/lib/auth/roles-shared";

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

/**
 * Could the caller's own membership rows narrow `orgs` at all?
 *
 * `my_organizations()` answers "which organizations may this account open":
 * its bound memberships, plus — for any platform role — the default org, plus
 * — for a platform owner/admin — EVERY organization (accessible_org_ids,
 * migration 0043). Only that last term adds orgs the caller is not a member
 * of, and every account it applies to also gets the default org. So a list
 * without the default org, or with one org only, is already exactly the
 * caller's memberships (or just the default), and the membership read would
 * change nothing: a customer's list is never narrowed, and no extra request is
 * made for them.
 */
export function membershipCanNarrow(orgs: OrgSummary[]): boolean {
  return orgs.length >= 2 && orgs.some((o) => o.is_default);
}

/**
 * The organizations the header's switcher offers, and the only ones the
 * dashboard may be "in" (resolveCurrentOrg runs over this list).
 *
 * The platform operator can READ every customer's workspace (support access,
 * the Customers section, migration 0138), but opening one as the current org
 * made their own Command Center act inside a customer's workspace and listed
 * every customer in the switcher. So for them it is their own memberships plus
 * the default org — reachable for every platform role even with no membership
 * row, so an operator who belongs to nothing still lands somewhere instead of
 * on /welcome. Everyone else gets `orgs` back unchanged (membershipCanNarrow).
 * The org role checks (lib/auth/org-roles.ts) read `current`, so they resolve
 * against these orgs too and refuse the operator inside a customer's workspace;
 * that is intended (owner decision, 2026-11-13), and support is read-only
 * through the Customers section.
 *
 * `memberIds` null means the membership read failed. The list fails closed to
 * the default org alone: listing every org would be the bug this fixes, and
 * refusing everything would lock the operator out of their own Command Center
 * over one failed read. It is not a quiet move, though: a request that
 * remembered a non-default org gets UNAVAILABLE instead of the default org
 * (getOrgContext, lib/orgs-server.ts), and the switch routes answer "could not
 * check" rather than "forbidden".
 */
export function switchableOrgs(orgs: OrgSummary[], memberIds: ReadonlySet<string> | null): OrgSummary[] {
  if (!membershipCanNarrow(orgs)) return orgs;
  if (memberIds === null) return orgs.filter((o) => o.is_default);
  return orgs.filter((o) => o.is_default || memberIds.has(o.id));
}

/** Org ids out of `org_members` rows; a malformed row is dropped, never guessed. */
export function coerceMemberOrgIds(data: unknown): Set<string> | null {
  if (!Array.isArray(data)) return null;
  const ids = new Set<string>();
  for (const row of data) {
    const id = row && typeof row === "object" ? (row as Record<string, unknown>).org_id : undefined;
    if (typeof id === "string" && id) ids.add(id);
  }
  return ids;
}

/** Trimmed name when it is acceptable, else null. Mirrors create_organization(). */
export function validateOrgName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed.length >= ORG_NAME_MIN && trimmed.length <= ORG_NAME_MAX ? trimmed : null;
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

/**
 * Must organizations (migration 0018) exist in this process? True in a
 * production build, where the database always has 0018: there, "the function
 * is missing" is a failure to fail closed on, not the pre-0018 world. False in
 * development and tests, where a database without 0018 is still a normal thing
 * to run against. See isOperator (lib/auth/org-roles.ts).
 */
export function organizationsAreExpected(env: string | undefined = process.env.NODE_ENV): boolean {
  return env === "production";
}
