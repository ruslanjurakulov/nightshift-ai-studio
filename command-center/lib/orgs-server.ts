import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { ORG_COOKIE, coerceOrgs, resolveCurrentOrg, type OrgSummary } from "@/lib/orgs";

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
 * a network call failed would be the wrong remedy.
 *
 * Wrapped in React's cache() so the layout and the page share one resolution
 * per request.
 */
export interface OrgContext {
  supported: boolean;
  orgs: OrgSummary[];
  current: OrgSummary | null;
}

const UNSUPPORTED: OrgContext = { supported: false, orgs: [], current: null };

export const getOrgContext = cache(async (): Promise<OrgContext> => {
  const supabase = await createClient();
  if (!supabase) return UNSUPPORTED;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return UNSUPPORTED;

  try {
    // Bind any invite addressed to this email first, so an org someone was
    // just invited to shows up on their very first page load.
    await supabase.rpc("bind_org_memberships");
    const { data, error } = await supabase.rpc("my_organizations");
    if (error) return UNSUPPORTED;
    const orgs = coerceOrgs(data);
    const remembered = (await cookies()).get(ORG_COOKIE)?.value;
    return { supported: true, orgs, current: resolveCurrentOrg(remembered, orgs) };
  } catch {
    return UNSUPPORTED;
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
