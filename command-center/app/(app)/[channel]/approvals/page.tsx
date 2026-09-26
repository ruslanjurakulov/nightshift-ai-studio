import { PageHeader } from "@/components/PageHeader";
import { ApprovalsBoard } from "@/components/approvals/ApprovalsBoard";
import { resolveCurrentOrgRole } from "@/lib/auth/org-roles";
import { createClient, getUser } from "@/lib/supabase/server";
import { getChannelSelection } from "@/lib/channels-server";
import { isScoped } from "@/lib/channels";
import { getDictionary } from "@/lib/i18n/server";
import type { ChannelRow } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Two-person publish approvals for the selected channel.
 *
 * A request log readable by any member of the channel's organization; an
 * editor+ there may open a request, and a SECOND admin there — never the
 * requester — may approve or reject. The database (migration 0009) enforces the
 * two-person rule regardless of what the UI shows. The per-channel requirement
 * toggle writes `channels.agent_config.require_two_person_publish`.
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
      <div className="rhythm">
        <PageHeader icon="approvals" title={t.approvals.title} subtitle={t.approvals.subtitle} />
        <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{t.approvals.signIn}</div>
      </div>
    );
  }

  if (!isScoped(selection)) {
    return (
      <div className="rhythm">
        <PageHeader icon="approvals" title={t.approvals.title} subtitle={t.approvals.subtitle} />
        <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{t.approvals.notConfigured}</div>
      </div>
    );
  }

  // Read the current channel's requirement flag so the toggle renders without a flash.
  let initialRequire = false;
  const supabase = await createClient();
  if (supabase) {
    const { data } = await supabase
      .from("channels")
      .select("agent_config")
      .eq("channel_id", selection)
      .maybeSingle();
    initialRequire = Boolean((data as Pick<ChannelRow, "agent_config"> | null)?.agent_config?.require_two_person_publish);
  }

  return (
    <div className="rhythm">
      <PageHeader icon="approvals" title={t.approvals.title} subtitle={t.approvals.subtitle} />
      <ApprovalsBoard
        channelId={selection}
        initialRequire={initialRequire}
        myRole={role}
        myEmail={user.email ?? ""}
        myUserId={user.id}
      />
    </div>
  );
}
