import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { StatCard, Panel, EmptyState } from "@/components/ui";
import { VideoTable } from "@/components/videos/VideoTable";
import { isToday, num } from "@/lib/format";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelSelection } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import type { MetricsSnapshotRow, VideoRow } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export interface VideoWithMetrics extends VideoRow {
  metrics: MetricsSnapshotRow | null;
}

export default async function VideoLibrary() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  // Scope channel-owned queries to the selected channel (view control;
  // RLS still decides what may be read at all).
  const selection = await getChannelSelection();

  const supabase = await createClient();
  let videos: VideoRow[] = [];
  let snapshots: MetricsSnapshotRow[] = [];
  let dbError = false;

  if (supabase) {
    const vid = await scopeQuery(
        supabase.from("videos").select("*"),
        selection,
      )
      .order("published_at", { ascending: false })
      .limit(100);
    if (vid.error) dbError = true;
    videos = (vid.data as VideoRow[]) ?? [];

    const ids = videos.map((v) => v.video_id);
    if (ids.length > 0) {
      const snap = await supabase
        .from("metrics_snapshots")
        .select("*")
        .in("video_id", ids)
        .order("snapshot_date", { ascending: false });
      if (snap.error) dbError = true;
      snapshots = (snap.data as MetricsSnapshotRow[]) ?? [];
    }
  }

  // Latest snapshot per video_id: snapshots are ordered snapshot_date desc, so
  // the first one seen for each video_id is the most recent.
  const latestByVideo = new Map<string, MetricsSnapshotRow>();
  for (const s of snapshots) {
    if (!latestByVideo.has(s.video_id)) latestByVideo.set(s.video_id, s);
  }

  const rows: VideoWithMetrics[] = videos.map((v) => ({
    ...v,
    metrics: latestByVideo.get(v.video_id) ?? null,
  }));

  const totalViews = rows.reduce((sum, r) => sum + (r.metrics?.views ?? 0), 0);
  const hasAnyViews = rows.some((r) => r.metrics?.views != null);
  const publishedToday = rows.filter((r) => isToday(r.published_at)).length;

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="videos" title={t.videos.title} subtitle={t.videos.subtitle} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={t.videos.videosShown} value={num(rows.length)} sub={t.videos.latest100} />
        <StatCard
          label={t.videos.totalViews}
          value={hasAnyViews ? num(totalViews) : t.common.na}
          tone="ok"
          sub={t.videos.acrossShown}
        />
        <StatCard label={t.videos.publishedToday} value={num(publishedToday)} tone="ok" sub={t.videos.videosLive} />
      </div>

      <Panel title={t.videos.library}>
        {dbError ? (
          <EmptyState>{t.videos.readErr}</EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState>{t.videos.empty}</EmptyState>
        ) : (
          <VideoTable rows={rows} />
        )}
      </Panel>
    </div>
  );
}
