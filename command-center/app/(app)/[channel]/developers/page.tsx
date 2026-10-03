import { PageHeader } from "@/components/PageHeader";
import { DeveloperConsole } from "@/components/developers/DeveloperConsole";
import { ConnectedApps } from "@/components/developers/ConnectedApps";
import { getOrgContext } from "@/lib/orgs-server";
import { getUser } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { atLeast } from "@/lib/auth/roles-shared";
import { paddleClient } from "@/lib/paddle";
import { paddleApi } from "@/lib/server/paddle-api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The Developer console (migration 0031): activate the API, keys, usage, the
 * prepaid API balance and its limits — for the workspace being viewed. Everything is read and written through the signed-in user's
 * own session and 0031's functions; the top-up checkout is Paddle's.
 */
export default async function DevelopersPage() {
  const { t } = await getDictionary();
  const [org, user] = await Promise.all([getOrgContext(), getUser()]);
  const current = org.supported ? org.current : null;

  return (
    <div className="rhythm">
      <PageHeader icon="developers" title={t.developers.title} subtitle={t.developers.subtitle} />
      {!user ? (
        <div className="panel p-5 sm:p-6 text-sm text-[var(--color-muted)]">{t.org.signIn}</div>
      ) : !current ? (
        <div className="panel p-5 sm:p-6 text-sm text-[var(--color-muted)]">{t.org.noOrg}</div>
      ) : !atLeast(current.role, "admin") ? (
        <div className="panel p-5 sm:p-6 text-sm text-[var(--color-muted)]">{t.developers.adminOnly}</div>
      ) : (
        <>
          <DeveloperConsole
          key={current.id}
          orgId={current.id}
          topup={paddleApi && paddleClient ? paddleClient : null}
          />
          {/* AI apps the person connected with OAuth (0093): separate from API keys and the API balance.
              Below the console, which loads first: this list arrives later and must not push it down. */}
          <ConnectedApps />
        </>
      )}
    </div>
  );
}
