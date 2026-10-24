import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getChannelPath } from "@/lib/channels-path-server";
import { getChannelScope } from "@/lib/channels-server";
import { channelInScope } from "@/lib/channels";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { ErrorState } from "@/components/ReadError";
import { EmptyState } from "@/components/ui";
import { PageHeader } from "@/components/PageHeader";
import { SeriesPlanView, type EpisodeRow } from "@/components/series/SeriesPlanView";
import { getDictionary } from "@/lib/i18n/server";
import { seriesFactoryEnabled } from "@/lib/server/series-factory";
import { readSeriesPlan } from "@/lib/server/seriesPlans";
import { chipHref, episodeChip, isSeriesId } from "@/lib/seriesPlan";
import "../../../app-pages-g2.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * One series plan (migration 0120, docs/SERIES_FACTORY.md slice S3): the outline cards, the hook and call-to-action variants, the
 * price of each episode and of the series, a status chip per episode, and the Start button.
 *
 * Behind the server flag SERIES_FACTORY_ENABLED (default off). Off, this is the public 404 and the FIRST thing that happens: nothing
 * below it runs, so a request makes no database call. A path that is not a plan id (a content series' slug lives under the same
 * folder) is a 404 as well, before the database is asked.
 *
 * Reads as the signed-in person (the anon key and their session; RLS shows a plan to members of its organization). The page changes
 * nothing: starting an episode is a button that calls a database function, which does its own checks and holds the credits.
 */
export default async function SeriesPlanPage({ params }: { params: Promise<{ id: string }> }) {
  if (!seriesFactoryEnabled()) notFound();
  const { id } = await params;
  if (!isSeriesId(id)) notFound();
  if (!isSupabaseConfigured) return <NotConfigured />;

  const { t } = await getDictionary();
  const s = t.seriesPlan;
  const path = await getChannelPath();
  const head = <PageHeader icon="series" title={s.page.title} subtitle={s.page.subtitle} />;
  const supabase = await createClient();
  if (!supabase) return <NotConfigured />;

  // Another organization's plan reads exactly like a missing one: RLS hides it from a member elsewhere, and a platform administrator
  // sees it only after switching to its organization (its episodes are then never asked for).
  const scope = await getChannelScope();
  const read = await readSeriesPlan(supabase, id, (channelId) => channelInScope(channelId, scope));
  if (read.state === "unsupported") {
    return (
      <div className="rhythm stagger-enter">
        {head}
        <EmptyState>{s.page.unsupported}</EmptyState>
      </div>
    );
  }
  if (read.state === "failed") {
    return (
      <div className="rhythm stagger-enter">
        {head}
        <ErrorState message={s.page.readFailed} />
      </div>
    );
  }
  if (read.state === "not_found") {
    return (
      <div className="rhythm stagger-enter">
        {head}
        <EmptyState>{s.page.notFound}</EmptyState>
      </div>
    );
  }

  const rows: EpisodeRow[] = read.episodes.map(({ episode, quote, links }) => {
    const chip = episodeChip(episode, quote, links);
    return { episode, quote, chip: chip.key, href: chipHref(path, chip) };
  });
  const created = read.plan.createdAt ? Date.parse(read.plan.createdAt) : NaN;

  return (
    <div className="rhythm stagger-enter">
      {head}
      <SeriesPlanView
        plan={read.plan}
        rows={rows}
        linksFailed={read.linksFailed}
        backHref={path("/series")}
        againHref={path("/series")}
        ageMinutes={Number.isFinite(created) ? Math.max(0, Math.floor((Date.now() - created) / 60000)) : null}
      />
    </div>
  );
}
