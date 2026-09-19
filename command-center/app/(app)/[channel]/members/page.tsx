import { PageHeader } from "@/components/PageHeader";
import { MembersBoard } from "@/components/members/MembersBoard";
import { resolveRole } from "@/lib/auth/roles";
import { getUser } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";

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
  const [role, user] = await Promise.all([resolveRole(), getUser()]);

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
