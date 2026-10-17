import { PageHeader } from "@/components/PageHeader";
import { Note } from "@/components/g3/Section";
import { ApprovalsBoard } from "@/components/approvals/ApprovalsBoard";
import { resolveCurrentOrgRole } from "@/lib/auth/org-roles";
import { getUser } from "@/lib/supabase/server";
import { getChannelSelection } from "@/lib/channels-server";
import { isScoped } from "@/lib/channels";
import { getDictionary } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Two-person publish approvals for the selected channel.
 *
 * A request log readable by any member of the channel's organization; an
 * editor+ there may open a request, and a SECOND admin there — never the
 * requester — may approve or reject. The database (migration 0009) enforces the
 * two-person rule regardless of what the UI shows. There is no per-channel
 * requirement switch: the feature is not offered to customers.
 *
 * The feature is per-channel, so it needs a channel selected. Across all
 * channels there is nothing to show — we say so rather than mixing channels.
 */
export default async function ApprovalsPage() {
  const { t } = await getDictionary();
  // The role in the selected channel's organization (the switcher only offers
  // that organization's channels) — the one 0018's publish_approvals policies
  // check. The two-person rule itself is unchanged: an editor+ requests, a
  // different admin decides, and the database refuses anything else.
  const [role, user, selection] = await Promise.all([
    resolveCurrentOrgRole(),
    getUser(),
    getChannelSelection(),
  ]);

  if (!user) {
    return (
      <div className="rhythm ns-open">
        <PageHeader icon="approvals" title={t.approvals.title} subtitle={t.approvals.subtitle} />
        <Note>{t.approvals.signIn}</Note>
      </div>
    );
  }

  if (!isScoped(selection)) {
    return (
      <div className="rhythm ns-open">
        <PageHeader icon="approvals" title={t.approvals.title} subtitle={t.approvals.subtitle} />
        <Note>{t.approvals.notConfigured}</Note>
      </div>
    );
  }

  return (
    <div className="rhythm ns-open">
      <PageHeader icon="approvals" title={t.approvals.title} subtitle={t.approvals.subtitle} />
      <ApprovalsBoard
        channelId={selection}
        myRole={role}
        myEmail={user.email ?? ""}
        myUserId={user.id}
      />
    </div>
  );
}
