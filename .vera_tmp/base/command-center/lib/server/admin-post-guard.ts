import "server-only";
import { NextResponse } from "next/server";
import { currentMfaAction } from "@/lib/auth/org-roles";
import type { MfaUser } from "@/lib/security/admin-mfa-server";
import { rejectCrossOrigin } from "@/lib/server/same-origin";

/**
 * The two checks every operator POST makes after it knows WHO is asking and
 * before it reads the body or changes anything:
 *
 * 1. Our own page sent it (the existing `isSameOriginPost`, as on the sign-up,
 *    invite and review-link routes). The operator routes used to rely on
 *    `SameSite=Lax` alone (ledger BR-S-007); a sibling host or a Lax bypass
 *    would have reached them. A request with no usable Origin is refused.
 * 2. If `user` is passed: the second-factor gate (docs/security/ADMIN_MFA.md).
 *    In `NIGHTSHIFT_ADMIN_MFA=enforce`, an admin with an authenticator whose
 *    session is password-only gets 401 `mfa_required`. A route that goes
 *    through `requireOperator` already has this check built in and passes no
 *    user; a route that goes through `requireRole` passes the user it read.
 *    The caller is a platform admin by then, so no second lookup is made.
 *
 * Returns the refusal to send, or null to carry on.
 */
const NO_STORE = { "cache-control": "no-store" };

export async function guardAdminPost(request: Request, user?: MfaUser | null): Promise<NextResponse | null> {
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  if (user) {
    const action = await currentMfaAction(user, true);
    if (action === "challenge") return NextResponse.json({ error: "mfa_required" }, { status: 401, headers: NO_STORE });
    // Strict `enforce`: an admin with no authenticator may only enrol (lib/security/admin-mfa.ts).
    if (action === "enrol_only") return NextResponse.json({ error: "mfa_enrol_required" }, { status: 403, headers: NO_STORE });
  }
  return null;
}
