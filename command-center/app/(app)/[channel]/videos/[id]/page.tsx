import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getChannelPath } from "@/lib/channels-path-server";
import { ReviewPanel } from "@/components/review/ReviewPanel";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Panel, StatCard, EmptyState, StatusPill } from "@/components/ui";
import { ViewsSparkline } from "@/components/videos/ViewsSparkline";
import { VideoLifecycle } from "@/components/videos/VideoLifecycle";
import { Storyboard } from "@/components/videos/Storyboard";
import { IntelligenceTrace } from "@/components/intel/IntelligenceTrace";
import { QualityGate } from "@/components/autonomy/QualityGate";
import { buildTrace } from "@/lib/decisions";
import { summarizeSceneRetention } from "@/lib/sceneRetention";
import { num, decimal, relativeTime, timeOfDay, statusTone } from "@/lib/format";
import { getDictionary } from "@/lib/i18n/server";
import { fetchChannelTopicScores } from "@/lib/channels-server";
import { fmt } from "@/lib/i18n";
import type { ChannelRow, FeedbackSignalRow, MetricsSnapshotRow, RetentionPointRow, ReviewIntentRow, SystemEventRow, TopicPerformanceRow, VideoRow } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const TONE_COLOR: Record<string, string> = {
  ok: "var(--color-ok)",
  run: "var(--color-primary)",
  fail: "var(--color-fail)",
  idle: "var(--color-idle)",
};

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
        {label}
      </div>
      <div className="text-sm text-[var(--color-fg)] break-words">{value}</div>
    </div>
  );
}

export default async function VideoDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { id } = await params;
  const { t } = await getDictionary();
  const path = await getChannelPath();

  const supabase = await createClient();
  let video: VideoRow | null = null;
  let snapshots: MetricsSnapshotRow[] = [];
  let events: SystemEventRow[] = [];
  let learningSignals: FeedbackSignalRow[] = [];
  let topicPerf: TopicPerformanceRow[] = [];
  let autoPublish = false;
  let pendingIntent: ReviewIntentRow | null = null;
  let retentionPoints: RetentionPointRow[] = [];

  if (supabase) {
    const [vid, snap, ev, fs, ret] = await Promise.all([
      supabase.from("videos").select("*").eq("video_id", id).maybeSingle(),
      supabase
        .from("metrics_snapshots")
        .select("*")
        .eq("video_id", id)
        .order("snapshot_date", { ascending: true }),
      supabase
        .from("system_events")
        .select("*")
        .eq("video_id", id)
        .order("ts", { ascending: true }),
      supabase.from("feedback_signals").select("*").eq("video_id", id).limit(50),
      // Every snapshot of this video's curve; lib/sceneRetention keeps the
      // newest measured_date. An error (0002 not applied) reads as "no curve".
      supabase
        .from("retention_points")
        .select("elapsed_ratio,watch_ratio,measured_date")
        .eq("video_id", id)
        .order("measured_date", { ascending: false })
        .limit(1000),
    ]);
    video = (vid.data as VideoRow | null) ?? null;
    snapshots = (snap.data as MetricsSnapshotRow[]) ?? [];
    events = (ev.data as SystemEventRow[]) ?? [];
    learningSignals = (fs.data as FeedbackSignalRow[]) ?? [];
    retentionPoints = ret.error ? [] : ((ret.data as RetentionPointRow[]) ?? []);
    // Scored against its OWN channel, not the switcher: a link to a video is
    // valid whatever channel is selected, and the score that explains this
    // video is the one its channel learned.
    if (video) {
      topicPerf = await fetchChannelTopicScores(supabase, video.channel_id);
      // The review panel needs two more facts: whether this channel publishes
      // on its own, and whether a request is already waiting on this video.
      const [ch, intent] = await Promise.all([
        supabase.from("channels").select("auto_publish").eq("channel_id", video.channel_id).maybeSingle(),
        supabase
          .from("review_intents")
          .select("*")
          .eq("video_id", id)
          .is("consumed_at", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      autoPublish = Boolean((ch.data as Pick<ChannelRow, "auto_publish"> | null)?.auto_publish);
      pendingIntent = (intent.data as ReviewIntentRow | null) ?? null;
    }
  }

  if (!video) {
    return (
      <div className="rhythm stagger-enter">
        <Link
          href={path("/videos")}
          className="mono text-[11px] text-[var(--color-primary)] hover:underline"
        >
          {t.videoDetail.back}
        </Link>
        <Panel title={t.videoDetail.notFound}>
          <EmptyState>
            {t.videoDetail.notFoundBodyA} <span className="mono text-[var(--color-fg)]">{id}</span>{" "}
            {t.videoDetail.notFoundBodyB}
          </EmptyState>
        </Panel>
      </div>
    );
  }

  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

  // `manifest` (migration 0013) is read untyped: the mapping only needs its
  // measured audio duration and parses it defensively.
  const sceneRetention = summarizeSceneRetention(
    video.scenes ?? null,
    (video as { manifest?: unknown }).manifest ?? null,
    retentionPoints,
  );

  // The gate's own words, read back from the event it emitted. A video with no
  // gate event has an unknown verdict — which the panel says, rather than
  // implying a pass.
  const gateEvent = [...events]
    .reverse()
    .find((e) => e.event === "publish.blocked" || e.event === "publish.allowed");
  const gateMeta = (gateEvent?.metadata ?? null) as
    | { allowed?: boolean; blocks?: string[]; warnings?: string[] }
    | null;
  const factEvent = [...events].reverse().find((e) => e.event.startsWith("fact_check"));
  const flaggedRaw = (factEvent?.metadata as { flagged?: unknown } | null)?.flagged;
  const gate = gateMeta
    ? {
        allowed: Boolean(gateMeta.allowed),
        reasons: [...(gateMeta.blocks ?? []), ...(gateMeta.warnings ?? [])],
        flagged: typeof flaggedRaw === "number" ? flaggedRaw : null,
      }
    : null;

  return (
    <div className="flex flex-col gap-4">
      <ReviewPanel
        video={video}
        autoPublish={autoPublish}
        gate={gate}
        pendingIntent={pendingIntent}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={path("/videos")}
            className="mono text-[11px] text-[var(--color-primary)] hover:underline"
          >
            {t.videoDetail.back}
          </Link>
          <h1 className="t-hero mt-2 truncate">{video.title ?? video.video_id}</h1>
          <p className="t-lead mt-4">
            {video.topic ?? t.videoDetail.noTopic} · {fmt(t.videoDetail.published, { t: relativeTime(video.published_at) })}
          </p>
        </div>
        <StatusPill
          tone={video.privacy === "public" ? "ok" : "idle"}
          label={(video.privacy ?? t.videoDetail.unknown).toUpperCase()}
        />
      </div>

      <Panel title={t.videoDetail.content}>
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t.videoDetail.fTitle} value={video.title ?? t.common.na} />
          <Field label={t.videoDetail.fTopic} value={video.topic ?? t.common.na} />
          <Field label={t.videoDetail.fSlug} value={video.slug ?? t.common.na} />
          <Field label={t.videoDetail.fPrivacy} value={video.privacy ?? t.common.na} />
          <Field
            label={t.videoDetail.fPublished}
            value={
              video.published_at ? (
                <span className="mono text-[13px]">{video.published_at}</span>
              ) : (
                t.common.na
              )
            }
          />
          <Field
            label={t.videoDetail.fVideoId}
            value={<span className="mono text-[13px]">{video.video_id}</span>}
          />
        </div>
      </Panel>

      <Panel title={t.videoDetail.storyboard}>
        <Storyboard
          scenes={video.scenes ?? null}
          scriptText={video.script_text}
          retention={sceneRetention}
          labels={{
            empty: t.videoDetail.storyboardEmpty,
            scene: t.videoDetail.storyboardScene,
            scenes: t.videoDetail.storyboardScenes,
            runtime: t.videoDetail.storyboardRuntime,
            approx: t.videoDetail.storyboardApprox,
            keywords: t.videoDetail.storyboardKeywords,
            claims: t.videoDetail.storyboardClaims,
            claimsNeedReview: t.videoDetail.storyboardClaimsNeedReview,
            claimsAdvisory: t.videoDetail.storyboardClaimsAdvisory,
            claimStatus: {
              likely_accurate: t.videoDetail.storyboardClaimAccurate,
              likely_inaccurate: t.videoDetail.storyboardClaimInaccurate,
              unverifiable: t.videoDetail.storyboardClaimUnverifiable,
              not_checked: t.videoDetail.storyboardClaimNotChecked,
            },
            retention: {
              title: t.videoDetail.storyboardRetention,
              note: t.videoDetail.storyboardRetentionNote,
              noCurve: t.videoDetail.storyboardRetentionNoCurve,
              noTiming: t.videoDetail.storyboardRetentionNoTiming,
              unknown: t.videoDetail.storyboardRetentionUnknown,
              points: t.videoDetail.storyboardRetentionPoints,
              perMin: t.videoDetail.storyboardRetentionPerMin,
              worst: t.videoDetail.storyboardRetentionWorst,
            },
          }}
        />
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={t.auto.gateTitle}>
        <QualityGate events={events} />
      </Panel>

      <Panel title={t.ops.lifecycleTitle}>
          <VideoLifecycle events={events} hasMetrics={snapshots.length > 0} hasLearning={learningSignals.length > 0} />
        </Panel>
        <Panel title={t.intel.traceTitle}>
          <IntelligenceTrace
            steps={buildTrace(
              video.video_id,
              video.topic,
              events,
              snapshots.length,
              learningSignals,
              topicPerf.find((p) => p.topic === video.topic) ?? null,
            )}
          />
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={t.videoDetail.pipeline}>
          {events.length === 0 ? (
            <EmptyState>{t.videoDetail.noPipeline}</EmptyState>
          ) : (
            <ol className="divide-y divide-[var(--color-border)]">
              {events.map((e) => {
                const tone = statusTone(e.status);
                return (
                  <li key={e.event_key} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <span className="mono w-16 shrink-0 text-[10px] text-[var(--color-muted)]">
                      {timeOfDay(e.ts)}
                    </span>
                    <span
                      className="glow-dot size-1.5 shrink-0 rounded-full"
                      style={{ color: TONE_COLOR[tone], background: TONE_COLOR[tone] }}
                    />
                    <span className="mono shrink-0 text-[11px] text-[var(--color-primary)]">
                      {e.agent ?? t.common.system}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[var(--color-fg)]">
                      {e.event}
                    </span>
                    {e.status && (
                      <span
                        className="shrink-0 text-[10px] uppercase tracking-[0.22em]"
                        style={{ color: TONE_COLOR[tone] }}
                      >
                        {e.status}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>

        <Panel title={t.videoDetail.analytics}>
          {latest === null ? (
            <EmptyState>{t.videoDetail.noAnalytics}</EmptyState>
          ) : (
            <div className="flex flex-col gap-4 p-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <StatCard label={t.videoDetail.views} value={num(latest.views)} tone="ok" />
                <StatCard label={t.videoDetail.likes} value={num(latest.likes)} />
                <StatCard label={t.videoDetail.comments} value={num(latest.comment_count)} />
                <StatCard
                  label={t.videoDetail.watchTime}
                  value={decimal(latest.watch_time_minutes)}
                />
                <StatCard
                  label={t.videoDetail.avgView}
                  value={decimal(latest.average_view_duration_seconds)}
                />
                <StatCard
                  label={t.videoDetail.snapshots}
                  value={num(snapshots.length)}
                  sub={fmt(t.videoDetail.latestT, { t: relativeTime(latest.snapshot_date) })}
                />
              </div>

              {snapshots.length >= 2 && (
                <div className="flex flex-col gap-2">
                  <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
                    {t.videoDetail.viewsOverTime}
                  </div>
                  <ViewsSparkline
                    label={t.videoDetail.viewsOverTime}
                    points={snapshots.map((s) => ({
                      date: s.snapshot_date,
                      views: s.views,
                    }))}
                  />
                </div>
              )}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
