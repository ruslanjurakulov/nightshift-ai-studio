import "server-only";
import { createClient, getUser } from "@/lib/supabase/server";
import { ROLES, atLeast, type Role } from "@/lib/auth/roles-shared";

// The role primitives (type, ordered list, rank, comparison) live in the
// client-safe roles-shared module so a "use client" component can import them
// without pulling this server-only file into the browser bundle. Re-exported
// here so existing server importers of "@/lib/auth/roles" keep working.
export { ROLES, atLeast, type Role };

/**
 * The caller's PLATFORM role — their row on the operator's roster
 * (`app_members`, migration 0007) — for actions that spend the operator's own
 * resources: GitHub secrets and variables, provider keys and top-ups, test
 * alerts. A customer's role in their own organization is a different question
 * (lib/auth/org-roles.ts).
 *
 * The answer comes from the security-definer SQL `bind_current_member()`: it
 * binds an invited-by-email roster row to the signed-in user on first use and
 * returns their role — or NULL for anyone not on the roster (migration 0033;
 * before it, 'viewer').
 *
 * FAIL CLOSED. Any error — the RPC failing, the network, an unexpected value —
 * means "no platform role". It used to mean 'owner' (a pre-0007 convenience),
 * which turned one failed database call into platform admin for every
 * signed-in account (security audit C4). The one exception is a Command
 * Center with no Supabase configured at all (local development): there is no
 * roster to ask and no one else to protect, so it stays 'owner'.
 */

function coerce(role: unknown): Role | null {
  return typeof role === "string" && (ROLES as string[]).includes(role) ? (role as Role) : null;
}

/**
 * The caller's platform role, binding an email invite on first use; null when
 * they are not signed in, not on the roster, or the lookup failed.
 */
export async function resolvePlatformRole(): Promise<Role | null> {
  const user = await getUser();
  if (!user) return null;
  const supabase = await createClient();
  if (!supabase) return "owner";
  try {
    const { data, error } = await supabase.rpc("bind_current_member");
    if (error) return null;
    return coerce(data);
  } catch {
    return null;
  }
}

/**
 * For pages that draw the platform roster's controls: the platform role, with
 * "no role" shown as the least one ('viewer'), which no control accepts.
 * Never use this to allow something — use requireRole.
 */
export async function resolveRole(): Promise<Role> {
  return (await resolvePlatformRole()) ?? "viewer";
}

/**
 * For API routes: the caller's platform role when it meets `min`, otherwise
 * null — the route's cue to answer 403. No platform role meets any minimum.
 */
export async function requireRole(min: Role): Promise<Role | null> {
  const role = await resolvePlatformRole();
  return role !== null && atLeast(role, min) ? role : null;
}
