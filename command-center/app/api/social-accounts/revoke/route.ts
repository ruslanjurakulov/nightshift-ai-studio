import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { logAudit } from "@/lib/server/audit";
import { fetchSocialAccount, revokeSocialAccount } from "@/lib/server/social-accounts";
import { PLATFORM_PERMISSIONS_URL } from "@/lib/social-accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Disconnect" for an Instagram / TikTok account (migration 0028).
 *
 * POST `{ account_id }`. An owner, admin or editor of the account's
 * organization, viewing it (requireOrgRole: another organization's account is
 * 404). revoke_social_account checks the role again and destroys the Vault
 * secrets. Access on the platform's side is removed by the user there — the
 * response carries the page, and the UI says so.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { account_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const accountId = typeof body.account_id === "string" ? body.account_id.trim() : "";
  if (!UUID_RE.test(accountId)) return NextResponse.json({ error: "account_required" }, { status: 400 });

  const account = await fetchSocialAccount(accountId);
  if (!account) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const access = await requireOrgRole({ orgId: account.org_id }, "editor");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const result = await revokeSocialAccount(accountId);
  if (!result.ok) {
    const status = result.error === "forbidden" ? 403 : result.error === "not_available" ? 503 : 502;
    return NextResponse.json({ error: result.error }, { status });
  }
  await logAudit({
    action: `social.${account.platform}.disconnect`,
    target: accountId,
    detail: { platform: account.platform, org_id: account.org_id, external_id: account.external_id, revoked: result.revoked },
  });
  return NextResponse.json({
    ok: true,
    revoked: result.revoked,
    permissions_url: PLATFORM_PERMISSIONS_URL[account.platform],
  });
}
