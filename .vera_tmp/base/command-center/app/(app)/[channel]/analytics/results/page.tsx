import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { Note } from "@/components/g3/Section";
import { ResultsDashboard } from "@/components/results/ResultsDashboard";
import "@/components/results/results.css";
import { getDictionary } from "@/lib/i18n/server";
import { getOrgContext } from "@/lib/orgs-server";
import { getChannelContext } from "@/lib/channels-server";
import { ALL_CHANNELS, channelPath } from "@/lib/channels";
import { resultsDashboardEnabled } from "@/lib/resultsDashboard/flag";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Results dashboard (NIGHTSHIFT_RESULTS_DASHBOARD, default off: this page is then a 404, exactly as if it did not exist).
 * For each connected channel and platform, how the published videos are doing: YouTube results where the daily poll has
 * collected them, and the workspace's publish history. Read only (docs/RESULTS_DASHBOARD.md): the numbers come from
 * /api/results, which reads stored snapshots under the member's own session and never calls a platform.
 */
export default async function ResultsPage() {
  if (!resultsDashboardEnabled()) notFound();
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const org = await getOrgContext();
  const header = <PageHeader icon="analytics" title={t.resultsDashboard.title} subtitle={t.resultsDashboard.subtitle} />;
  if (!org.supported) return <div className="rhythm ns-open">{header}<Note>{t.org.notMigrated}</Note></div>;
  if (!org.current) return <div className="rhythm ns-open">{header}<Note>{t.org.noOrg}</Note></div>;
  const { slug, selection } = await getChannelContext();
  return (
    <div className="rhythm ns-open stagger-enter">
      {header}
      <ResultsDashboard
        initialChannel={selection === ALL_CHANNELS ? null : selection}
        videosHref={channelPath(slug, "/videos")}
        channelsHref={channelPath(slug, "/channels")}
      />
    </div>
  );
}
