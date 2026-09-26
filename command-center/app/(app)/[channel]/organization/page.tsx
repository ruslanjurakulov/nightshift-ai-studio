import { PageHeader } from "@/components/PageHeader";
import { OrgMembersBoard } from "@/components/org/OrgMembersBoard";
import { CreateOrganizationForm } from "@/components/org/CreateOrganizationForm";
import { getOrgContext } from "@/lib/orgs-server";
import { getUser } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The current organization: its name, its team, and a way to start another.
 *
 * Which org is "current" was decided on the server (lib/orgs-server.ts) from
 * the caller's memberships; the roster below is read and written under the
 * org_members policies of migration 0018. Before that migration this page
 * says so rather than showing an empty team.
 */
export default async function OrganizationPage() {
  const { t } = await getDictionary();
  const [org, user] = await Promise.all([getOrgContext(), getUser()]);

  return (
    <div className="rhythm">
      <PageHeader icon="organization" title={t.org.title} subtitle={t.org.subtitle} />
      {!user ? (
        <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{t.members.signIn}</div>
      ) : !org.supported ? (
        <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{t.org.notMigrated}</div>
      ) : org.current ? (
        <>
          <OrgMembersBoard key={org.current.id} org={org.current} myUserId={user.id} />
          <CreateOrganizationForm variant="another" />
        </>
      ) : (
        <CreateOrganizationForm variant="first" />
      )}
    </div>
  );
}
