import { PageHeader } from "@/components/PageHeader";
import { OrgMembersBoard } from "@/components/org/OrgMembersBoard";
import { CreateOrganizationForm } from "@/components/org/CreateOrganizationForm";
import { PendingInvites } from "@/components/org/PendingInvites";
import { getOrgContext } from "@/lib/orgs-server";
import { isOperator } from "@/lib/auth/org-roles";
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
 *
 * A self-serve customer sees their workspace, not a team: no roles, no
 * invites, no roster (they own what they create). The team board is the
 * platform operator's until a Teams plan brings it back to customers.
 */
export default async function OrganizationPage() {
  const { t } = await getDictionary();
  const [org, user, operator] = await Promise.all([getOrgContext(), getUser(), isOperator()]);

  return (
    <div className="rhythm">
      <PageHeader icon="organization" title={t.org.title} subtitle={operator ? t.org.subtitle : t.org.customerSubtitle} />
      {!user ? (
        <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{t.members.signIn}</div>
      ) : !org.supported ? (
        <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{t.org.notMigrated}</div>
      ) : org.current ? (
        <>
          <PendingInvites />
          <OrgMembersBoard key={org.current.id} org={org.current} myUserId={user.id} team={operator} />
          <CreateOrganizationForm variant="another" />
        </>
      ) : (
        <>
          <PendingInvites />
          <CreateOrganizationForm variant="first" />
        </>
      )}
    </div>
  );
}
