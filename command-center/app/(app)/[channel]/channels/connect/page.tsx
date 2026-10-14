import { cookies } from "next/headers";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import "../../../app-pages-g2.css";
import { ConnectPicker } from "@/components/channels/ConnectPicker";
import { getDictionary } from "@/lib/i18n/server";
import { getUser } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { PENDING_COOKIE, readPending } from "@/lib/server/connect-pending";
import { linkedYoutubeChannels } from "@/lib/server/connect-youtube";
import { fetchSocialAccounts } from "@/lib/server/social-accounts";
import { accountLabel } from "@/lib/social-accounts";
import type { PickView } from "@/lib/connect-picker";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Where a platform's sign-in lands (/api/oauth/{youtube,instagram,tiktok}/callback
 * with the pick flow): choose the account to add.
 *
 * What the person is shown is built here from the authorisation the server
 * holds for THIS user in THIS organization — the handle is an httpOnly cookie,
 * the token never leaves the server, and the props below carry names, avatars
 * and counts only. Nothing waiting (expired, another account, already
 * finished) renders the picker's own "start again" state.
 */
export default async function ConnectPickPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const user = await getUser();
  const org = await getOrgContext();
  const orgId = org.supported && org.current ? org.current.id : null;
  const handle = (await cookies()).get(PENDING_COOKIE)?.value;
  const held = user ? readPending(handle, { userId: user.id, orgId }) : null;

  let view: PickView | null = null;
  if (held && orgId) {
    const grant = held.grant;
    if (grant.platform === "youtube") {
      const linked = await linkedYoutubeChannels(orgId);
      view = {
        platform: "youtube",
        expiresAt: held.expiresAt,
        candidates: grant.candidates.map((c) => ({ ...c, linkedTo: linked?.get(c.id) ?? null })),
      };
    } else {
      const { rows } = await fetchSocialAccounts(orgId);
      const p = grant.profile;
      view = {
        platform: grant.platform,
        expiresAt: held.expiresAt,
        account: {
          externalId: p.externalId,
          name: accountLabel({ display_name: p.displayName, username: p.username, external_id: p.externalId }),
          username: p.username,
          avatarUrl: p.avatarUrl,
          connected: rows.some((r) => r.platform === grant.platform && r.external_id === p.externalId && r.status !== "revoked"),
        },
      };
    }
  }

  return (
    <div className="rhythm ns-open mx-auto w-full max-w-3xl">
      <PageHeader icon="channels" title={t.connectPicker.title} subtitle={t.connectPicker.subtitle} />
      <ConnectPicker view={view} />
    </div>
  );
}
