import "server-only";
import { createClient, getUser } from "@/lib/supabase/server";
import { ROLES, atLeast, type Role } from "@/lib/auth/roles-shared";

// The role primitives (type, ordered list, rank, comparison) live in the
// client-safe roles-shared module so a "use client" component can import them
// without pulling this server-only file into the browser bundle. Re-exported
// here so existing server importers of "@/lib/auth/roles" keep working.
export { ROLES, atLeast, type Role };

/**
 * Role-based access for the Command Center.
 *
 * The effective role comes from `app_members` via the security-definer SQL
 * `bind_current_member()` (migration 0007): it binds an invited-by-email row to
 * the signed-in user on first use and returns their role. Two deliberate
 * fallbacks keep existing single-operator setups working with no change:
 *
 * - Supabase not configured  → 'owner' (local/dev, no backend to consult).
 * - The RPC errors (migration not applied yet) → 'owner', i.e. the old
 *   all-admin behavior. Roles only start constraining once 0007 is applied AND
 *   the first member row exists (until then the SQL itself returns 'owner').
 *
 * A user who is not signed in is 'viewer' here; the routes and pages also gate
 * on `getUser()`, so an anonymous caller never reaches a privileged action.
 */

function coerce(role: unknown): Role {
  return typeof role === "string" && (ROLES as string[]).includes(role) ? (role as Role) : "viewer";
}

/** The caller's effective role, binding an email invite on first use. */
export async function resolveRole(): Promise<Role> {
  const user = await getUser();
  if (!user) return "viewer";
  const supabase = await createClient();
  if (!supabase) return "owner";
  try {
    const { data, error } = await supabase.rpc("bind_current_member");
    if (error) return "owner";
    return coerce(data);
  } catch {
    return "owner";
  }
}

/**
 * For API routes: the caller's role when it meets `min`, otherwise null. A null
 * return is the route's cue to answer 403 — the caller is signed in but lacks
 * the role for this action.
 */
export async function requireRole(min: Role): Promise<Role | null> {
  const role = await resolveRole();
  return atLeast(role, min) ? role : null;
}
