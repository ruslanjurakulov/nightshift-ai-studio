import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { logAudit } from "@/lib/server/audit";
import { resolveTokenStore, revokeVaultToken } from "@/lib/server/channel-tokens";
import { GOOGLE_PERMISSIONS_URL } from "@/lib/channel-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Disconnect" for a customer channel's YouTube connection (migration 0022).
 *
 * POST `{ channel_id }`. An owner/admin of the channel's organization, viewing
 * it (requireOrgRole: another organization's channel is 404). revoke_channel_token
 * checks the role again, destroys the Vault secret and stamps revoked_at; the
 * next run falls back to the channel's GitHub secret if it has one, else runs
 * without a token (publishing skipped).
 *
 * The app cannot revoke the grant at Google — that needs the token, which the
 * browser-facing app can never read — so the response carries the Google page
 * where the user removes it, and the UI tells them to.
 *
 * The operator's own channels are not disconnected here: their token is a
 * GitHub secret, managed on the Providers board as before.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { channel_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const channelId = typeof body.channel_id === "string" ? body.channel_id.trim() : "";
  if (!channelId) return NextResponse.json({ error: "channel_required" }, { status: 400 });

  const store = await resolveTokenStore(channelId);
  if (store.mode === "unavailable") return NextResponse.json({ error: "org_unavailable" }, { status: 503 });
  if (store.mode !== "vault") return NextResponse.json({ error: "not_a_vault_channel" }, { status: 400 });

  const access = await requireOrgRole({ channelId }, "admin");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const result = await revokeVaultToken(channelId);
  if (!result.ok) {
    const status = result.error === "forbidden" ? 403 : result.error === "not_available" ? 503 : 502;
    return NextResponse.json({ error: result.error }, { status });
  }
  await logAudit({
    action: "channel.youtube.disconnect",
    channelId,
    detail: { store: "vault", revoked: result.revoked },
  });
  return NextResponse.json({ ok: true, revoked: result.revoked, google_permissions_url: GOOGLE_PERMISSIONS_URL });
}
