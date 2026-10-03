import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { WorkspaceNameForm } from "@/components/org/WorkspaceNameForm";
import { CreateOrganizationForm } from "@/components/org/CreateOrganizationForm";
import { getOrgContext } from "@/lib/orgs-server";
import { getUser } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { getChannelPath } from "@/lib/channels-path-server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Settings: the workspace's name, and the way to Developers (API keys).
 *
 * There are two kinds of people in this product: a signed-in user, who owns
 * their workspace and does everything in it, and the platform operator, who
 * also sees the operator pages. So there is no team here: no roles, no
 * invitations, no members table. Which workspace is "current" is decided on
 * the server (lib/orgs-server.ts) from the caller's own memberships; before
 * migration 0018 this page says so rather than showing an empty form.
 */
export default async function SettingsPage() {
  const { t } = await getDictionary();
  const [org, user, path] = await Promise.all([getOrgContext(), getUser(), getChannelPath()]);

  return (
    <div className="rhythm">
      <PageHeader icon="organization" title={t.org.title} subtitle={t.org.customerSubtitle} />
      {!user ? (
        <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{t.org.signIn}</div>
      ) : !org.supported ? (
        <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{t.org.notMigrated}</div>
      ) : org.current ? (
        <>
          <WorkspaceNameForm key={org.current.id} org={org.current} />
          <div className="panel flex flex-col gap-3 p-4">
            <h2 className="t-section">{t.org.developersTitle}</h2>
            <p className="text-[13px] text-[var(--color-muted)]">{t.org.developersHint}</p>
            <Link href={path("/developers")} className="btn-sky is-solid pill self-start px-5 py-2 text-[13px]">
              {t.org.developersOpen}
            </Link>
          </div>
          <CreateOrganizationForm variant="another" />
        </>
      ) : (
        <CreateOrganizationForm variant="first" />
      )}
    </div>
  );
}
