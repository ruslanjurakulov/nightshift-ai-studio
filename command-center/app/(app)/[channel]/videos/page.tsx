import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { StatCard, Panel, EmptyState } from "@/components/ui";
import { VideoTable } from "@/components/videos/VideoTable";
import { isToday, num, relativeTime } from "@/lib/format";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelScope } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import { getChannelPath } from "@/lib/channels-path-server";
import { heldOnly, heldState, heldStateLabel, uploadedOnly } from "@/lib/heldVideos";
import Link from "next/link";
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
  const scope = await getChannelScope();
  const path = await getChannelPath();

  const supabase = await createClient();
  let videos: VideoRow[] = [];
  let held: VideoRow[] = [];
  let snapshots: MetricsSnapshotRow[] = [];
  let dbError = false;

  if (supabase) {
    // The library is what reached YouTube; a held run (lib/heldVideos) has no
    // publish time, would sort FIRST in this descending order, and has no
    // metrics — it is listed on its own, below, never as a published video.
    const [vid, heldFirst] = await Promise.all([
      uploadedOnly(scopeQuery(supabase.from("videos").select("*"), scope))
        .order("published_at", { ascending: false })
        .limit(100),
      heldOnly(scopeQuery(supabase.from("videos").select("*"), scope))
        .order("held_at", { ascending: false, nullsFirst: false })
        .limit(50),
    ]);
    if (vid.error) dbError = true;
    videos = (vid.data as VideoRow[]) ?? [];
    // Without migration 0016 there is no held_at to order by; read the held
    // rows unordered rather than not at all.
    const heldRes = heldFirst.error
      ? await heldOnly(scopeQuery(supabase.from("videos").select("*"), scope)).limit(50)
      : heldFirst;
    held = heldRes.error ? [] : ((heldRes.data as VideoRow[]) ?? []);

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

      {held.length > 0 && (
        <Panel title={t.held.title} right={<span className="t-label">{num(held.length)}</span>}>
          <p className="px-4 pt-3 text-[12px] leading-relaxed text-[var(--color-muted)]">{t.held.note}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
                  <th className="px-4 py-2 font-semibold">{t.videos.thTitle}</th>
                  <th className="px-4 py-2 font-semibold">{t.videos.thTopic}</th>
                  <th className="px-4 py-2 font-semibold">{t.held.thState}</th>
                  <th className="px-4 py-2 font-semibold">{t.held.thHeld}</th>
                </tr>
              </thead>
              <tbody>
                {held.map((v) => (
                  <tr key={v.video_id} className="border-b border-[var(--color-border)]/50">
                    <td className="px-4 py-2 text-[var(--color-fg)]">
                      <Link href={path(`/videos/${v.video_id}`)} className="hover:text-[var(--color-primary)]">
                        {v.title ?? v.topic ?? v.video_id}
                      </Link>
                      <span
                        className="ml-2 rounded border px-1.5 py-0.5 align-middle text-[9px] font-semibold uppercase tracking-[0.22em]"
                        style={{ borderColor: "var(--color-warn)", color: "var(--color-warn)" }}
                      >
                        {t.held.badge}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-[var(--color-muted)]">{v.topic ?? t.common.na}</td>
                    <td className="px-4 py-2 text-[var(--color-fg)]">{heldStateLabel(heldState(v), t.held)}</td>
                    <td className="px-4 py-2 mono text-[11px] text-[var(--color-muted)]">
                      {v.held_at ? relativeTime(v.held_at) : t.common.na}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

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
