import { PageHeader } from "@/components/PageHeader";
import { DeveloperConsole } from "@/components/developers/DeveloperConsole";
import { ConnectedApps } from "@/components/developers/ConnectedApps";
import { getOrgContext } from "@/lib/orgs-server";
import { getUser } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { atLeast } from "@/lib/auth/roles-shared";
import { paddleApi } from "@/lib/server/paddle-api";
import { paddleClientFor, paymentsProvider } from "@/lib/server/payments";
import { docsOrigin } from "@/lib/api/docs-origin";
import { mcpOauthLive } from "@/lib/mcp-oauth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The Developer console (migration 0031): activate the API, keys, usage, the
 * prepaid API balance and its limits — for the workspace being viewed. Three tabs
 * (Keys, Usage and billing, Connected apps) under one strip that shows the shared API
 * balance with "Add funds". Everything is read and written through the signed-in user's
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
        <DeveloperConsole
          key={current.id}
          orgId={current.id}
          // API balance top-ups are a Paddle custom-amount transaction; there is no Dodo equivalent yet
          // (docs/DODO_SETUP.md, open questions), so with PAYMENTS_PROVIDER=dodo the console says "not available yet".
          // Paddle in sandbox: only an allow-listed test workspace (PADDLE_TEST_ORG_IDS) is offered the top-up.
          topup={paymentsProvider() !== "dodo" && paddleApi ? paddleClientFor(current.id) : null}
          // The "Add to …" buttons start a sign-in, so they exist only while the server takes one (lib/mcp-oauth.ts).
          connectedApps={<ConnectedApps mcpUrl={`${docsOrigin()}/api/mcp`} oauthLive={mcpOauthLive()} />}
        />
      )}
    </div>
  );
}
