import { PageHeader } from "@/components/PageHeader";
import { MembersBoard } from "@/components/members/MembersBoard";
import { resolveRole } from "@/lib/auth/roles";
import { getUser } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { getOrgContext } from "@/lib/orgs-server";
import { createClient } from "@/lib/supabase/server";
import { getChannelPath } from "@/lib/channels-path-server";
import Link from "next/link";

/**
 * Is the caller on the platform roster at all? After migration 0018 a tenant
 * who signed up for their own organization is not, and this roster (which
 * decides credentials, providers and runs for the operator) is not theirs to
 * see — RLS returns them no rows. Showing them an empty roster would offer
 * "claim ownership", which the database would refuse; say where their team
 * lives instead. Before 0018 (no platform_role function) the page is unchanged.
 */
async function isOutsidePlatform(): Promise<boolean> {
  const org = await getOrgContext();
  if (!org.supported) return false;
  const supabase = await createClient();
  if (!supabase) return false;
  const { data, error } = await supabase.rpc("platform_role");
  return !error && data == null;
}

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Team & roles — who may sign in and what each person can do.
 *
 * The roster is readable by any signed-in user (RLS grants select to all
 * authenticated); the write controls only appear for an owner/admin, and the
 * database enforces the same rule regardless of what the UI shows. While the
 * roster is empty every signed-in user is the effective owner, so the first
 * person here claims ownership — see migration 0007.
 */
export default async function MembersPage() {
  const { t } = await getDictionary();
  const [role, user, outside, path] = await Promise.all([
    resolveRole(),
    getUser(),
    isOutsidePlatform(),
    getChannelPath(),
  ]);

  if (user && outside) {
    return (
      <div className="rhythm">
        <PageHeader icon="members" title={t.org.platformTitle} subtitle={t.members.subtitle} />
        <div className="panel flex flex-col gap-3 p-4">
          <p className="text-[13px] text-[var(--color-muted)]">{t.org.platformOnly}</p>
          <Link href={path("/organization")} className="btn-sky is-solid pill self-start px-5 py-2 text-[13px]">
            {t.org.openOrg}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="rhythm">
      <PageHeader icon="members" title={t.members.title} subtitle={t.members.subtitle} />
      {user ? (
        <MembersBoard myRole={role} myEmail={user.email ?? ""} myUserId={user.id} />
      ) : (
        <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{t.members.signIn}</div>
      )}
    </div>
  );
}
