import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { getOrgContext } from "@/lib/orgs-server";
import { getDictionary } from "@/lib/i18n/server";
import { readBrainFacts } from "@/lib/server/brain-facts";
import { BrainDashboard } from "@/components/brain/BrainDashboard";
import { readBrainChannel } from "@/lib/server/brain-channel";
import { getChannelScope } from "@/lib/channels-server";
import { resolveCurrentOrgRole } from "@/lib/auth/org-roles";
import { atLeast } from "@/lib/auth/roles-shared";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The customer's Nightshift Brain: their channel, their credits and how long
 * they last, what they made and what the Brain remembers, on one screen.
 *
 * Everything is read as the signed-in person: brain_org_facts (migration 0201)
 * answers for the open workspace only. The channel's numbers come from S10's
 * research readers (research_own_channel, research_comment_themes); before
 * they are deployed that section says so, never a 0. Nothing on this page renders, charges or publishes (CLAUDE.md
 * rule 3): the one button that asks for fresh numbers writes a request row and
 * stops.
 */
export default async function BrainPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const td = t.brainDash;
  const header = <PageHeader icon="brain" title={td.title} subtitle={td.subtitle} />;
  const org = await getOrgContext();
  if (!org.supported || !org.current) {
    return (
      <div className="rhythm ns-open">
        {header}
        <div className="panel p-5 text-sm text-[var(--color-muted)]">{org.supported ? td.noOrg : t.org.notMigrated}</div>
      </div>
    );
  }
  const [read, channel, role] = await Promise.all([
    readBrainFacts(org.current.id),
    getChannelScope().then(readBrainChannel),
    resolveCurrentOrgRole(),
  ]);
  return (
    <div className="rhythm ns-open">
      {header}
      <BrainDashboard read={read} channel={channel} renderedAt={new Date().toISOString()} canRefresh={atLeast(role, "editor")} />
    </div>
  );
}
