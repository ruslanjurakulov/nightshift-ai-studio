/**
 * Role primitives shared by the server (roles.ts) and client components
 * (e.g. MembersBoard). Deliberately free of any server-only import so a
 * "use client" component can pull in the type and the ordered list without
 * dragging the Supabase server client into the browser bundle.
 */

export type Role = "owner" | "admin" | "editor" | "viewer";

/** Most privileged first — the order the UI lists roles in. */
export const ROLES: Role[] = ["owner", "admin", "editor", "viewer"];

/** Numeric rank for "at least this role" comparisons. */
export const RANK: Record<Role, number> = { owner: 4, admin: 3, editor: 2, viewer: 1 };

export function atLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}
