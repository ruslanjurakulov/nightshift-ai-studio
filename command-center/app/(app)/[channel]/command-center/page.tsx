import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getChannelPath } from "@/lib/channels-path-server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { EmptyState, StatusPill } from "@/components/ui";
import { ActivityFeed } from "@/components/ActivityFeed";
import { SystemStatus } from "@/components/SystemStatus";
import { DailyMission } from "@/components/DailyMission";
import { Widget } from "@/components/dashboard/Widget";
import { CustomizeButton } from "@/components/dashboard/CustomizeButton";
import { PipelineStrip, type StageTone } from "@/components/dashboard/PipelineStrip";
import { QuotaGauges } from "@/components/dashboard/QuotaGauges";
import { deriveAdvisory } from "@/lib/advisory";
import { quotaGaugeView } from "@/lib/quota-gauge";
import { inferNextStage, dailyMission, PIPELINE_ORDER, type PipelineStageKey } from "@/lib/intelligence";
import { getDictionary } from "@/lib/i18n/server";
import { fetchTopicScores, getChannelContext } from "@/lib/channels-server";
import { isScoped, scopeQuery } from "@/lib/channels";
import { isGithubConfigured } from "@/lib/server/github-secrets";
import { RunNowButton } from "@/components/agents/RunNowButton";
import { fmt } from "@/lib/i18n";
import type { FeedbackSignalRow, MetricsSnapshotRow, SystemEventRow, TopicPerformanceRow, VideoRow } from "@/lib/types";
import { isToday, num, relativeTime, statusTone, storedMs } from "@/lib/format";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What each stage of the run actually did, read from real events only.
 *
 * A stage nothing has been recorded for stays "idle": it is never claimed as
 * done and never invented as running. Events arrive newest-first, so the first
 * one that maps to a stage carries that stage's outcome.
 */
function stageTones(events: SystemEventRow[]): Record<PipelineStageKey, StageTone> {
  const tones = Object.fromEntries(
    PIPELINE_ORDER.map((s) => [s, "idle" as StageTone]),
  ) as Record<PipelineStageKey, StageTone>;
  const seen = new Set<PipelineStageKey>();

  for (const e of events) {
    const name = e.event.toLowerCase();
    const stage: PipelineStageKey | null = name.startsWith("video.published")
      ? "publish"
      : (PIPELINE_ORDER.find((s) => name.startsWith(s + ".")) ?? null);
    if (!stage || seen.has(stage)) continue;
    seen.add(stage);

    const tone = statusTone(e.status);
    tones[stage] =
      tone === "fail"
        ? "fail"
        : tone === "run"
          ? "run"
          : name.endsWith(".completed") || name.startsWith("video.published")
            ? "done"
            : "idle";
  }
  return tones;
}

export default async function CommandCenter() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const path = await getChannelPath();
  // Scope every channel-owned query to the selected channel (view control;
  // RLS still decides what may be read at all).
  const { selection, channels } = await getChannelContext();
  // The primary "Produce a video" action needs one verified channel and the
  // GitHub dispatch wiring; when either is missing the hero keeps its
  // navigation buttons only, rather than showing a dead control.
  const scopedChannel = isScoped(selection)
    ? channels.find((c) => c.channel_id === selection)
    : undefined;
  const canProduce = Boolean(scopedChannel) && isGithubConfigured;

  const supabase = await createClient();
  let events: SystemEventRow[] = [];
  let videos: VideoRow[] = [];
  let topics: TopicPerformanceRow[] = [];
  let snapshots: MetricsSnapshotRow[] = [];
  let signals: FeedbackSignalRow[] = [];
  let dbHealthy = true;

  if (supabase) {
    const [ev, vid, tp, snap, sg] = await Promise.all([
      scopeQuery(supabase.from("system_events").select("*"), selection, { nullIsGlobal: true }).order("ts", { ascending: false }).limit(200),
      scopeQuery(supabase.from("videos").select("*"), selection).order("published_at", { ascending: false }).limit(50),
      fetchTopicScores(supabase, selection, 6),
      supabase.from("metrics_snapshots").select("*").order("snapshot_date", { ascending: false }).limit(200),
      scopeQuery(supabase.from("feedback_signals").select("*"), selection).order("analyzed_date", { ascending: false }).limit(200),
    ]);
    if (ev.error || vid.error) dbHealthy = false;
    events = (ev.data as SystemEventRow[]) ?? [];
    videos = (vid.data as VideoRow[]) ?? [];
    topics = tp;
    snapshots = (snap.data as MetricsSnapshotRow[]) ?? [];
    signals = (sg.data as FeedbackSignalRow[]) ?? [];
  }

  const publishedToday = videos.filter((v) => isToday(v.published_at)).length;
  const errors24h = events.filter(
    (e) => statusTone(e.status) === "fail" && Date.now() - (storedMs(e.ts) ?? 0) < DAY_MS,
  ).length;
  const runningAgents = Array.from(
    new Set(events.filter((e) => statusTone(e.status) === "run").map((e) => e.agent)),
  ).filter(Boolean);
  const lastEventAt = events[0]?.ts ?? null;
  const healthy = dbHealthy && errors24h === 0;
  const recentVideos = videos.slice(0, 6);
  const mission = dailyMission(videos, snapshots, signals);
  const next = inferNextStage(events);
  const tones = stageTones(events);
  // Roadmap #77: draw the day's upload-quota split (quota.allocated event) as
  // per-channel gauges. Advisory read only — it shows what the allocator
  // recommended, it never schedules.
  const quotaView = quotaGaugeView(deriveAdvisory(events).quota);

  // The hero names the most recent real video; the lead says what the pipeline
  // is doing right now. Neither is filled in when there is nothing to say.
  const latest = videos[0] ?? null;
  const STAGE_LABEL: Record<PipelineStageKey, string> = {
    topic: t.pipeline.sTopic,
    research: t.pipeline.sResearch,
    script: t.pipeline.sScript,
    voice: t.pipeline.sVoice,
    media: t.pipeline.sMedia,
    thumbnail: t.pipeline.sThumbnail,
    render: t.pipeline.sRender,
    upload: t.pipeline.sUpload,
    publish: t.pipeline.sPublish,
  };
  const lead = next
    ? fmt(t.dashboard.leadNext, { s: STAGE_LABEL[next.key] })
    : videos.length
      ? t.dashboard.leadDone
      : t.dashboard.leadIdle;

  return (
    <div className="rhythm stagger-enter">
      {/* ── The run, and the instruments beside it ─────────────────────────── */}
      <div className="flex flex-col gap-14 lg:flex-row lg:gap-20">
        <div className="flex min-w-0 flex-1 flex-col gap-10">
          <div>
            <div className="t-label">
              {lastEventAt ? `${t.dashboard.latestRun} · ${relativeTime(lastEventAt)}` : t.dashboard.noRunsYet}
            </div>
            <h1 className="t-hero mt-5">{latest?.title ?? t.dashboard.heroIdle}</h1>
            <p className="t-lead mt-6">{lead}</p>
          </div>

          <div className="flex flex-wrap gap-x-14 gap-y-8">
            <Figure label={t.dashboard.publishedToday} value={num(publishedToday)} />
            <Figure
              label={t.dashboard.activeAgents}
              value={num(runningAgents.length)}
              sub={runningAgents.length ? runningAgents.join(", ") : t.common.idle}
              tone={runningAgents.length ? "var(--color-warn)" : undefined}
            />
            <Figure
              label={t.dashboard.errors24h}
              value={num(errors24h)}
              sub={errors24h ? t.dashboard.needsAttention : t.common.none}
              tone={errors24h ? "var(--color-fail)" : "var(--color-ok)"}
            />
            <Figure
              label={t.dashboard.videos}
              value={num(videos.length >= 8 ? undefined : videos.length)}
              sub={videos.length >= 8 ? t.dashboard.showingLatest8 : t.dashboard.inLibrary}
            />
          </div>

          <div className="flex flex-wrap items-center gap-4">
            {canProduce && scopedChannel && (
              <RunNowButton
                variant="inline"
                channelId={scopedChannel.channel_id}
                githubConfigured={isGithubConfigured}
                label={t.dashboard.produce}
              />
            )}
            <Link
              href={path("/pipeline")}
              className={`btn-sky pill px-[30px] py-3.5 text-[14px]${canProduce ? "" : " is-solid"}`}
            >
              {t.dashboard.openPipeline}
              <span className="btn-arrow" aria-hidden>
                →
              </span>
            </Link>
            <Link href={path("/videos")} className="btn-sky pill px-[30px] py-3.5 text-[14px]">
              {t.dashboard.openVideos}
            </Link>
            <CustomizeButton />
            <StatusPill
              tone={healthy ? "ok" : errors24h > 0 ? "fail" : "run"}
              label={healthy ? t.dashboard.systemHealthy : errors24h > 0 ? t.dashboard.attention : t.dashboard.active}
              live={healthy}
            />
          </div>

          <div>
            <div className="t-label mb-5">{t.dashboard.recentVideos}</div>
            {recentVideos.length === 0 ? (
              <EmptyState>{t.dashboard.noVideos}</EmptyState>
            ) : (
              <ul>
                {recentVideos.map((v) => (
                  <li
                    key={v.video_id}
                    className="row-sweep flex items-baseline justify-between gap-6 border-b border-[var(--color-border)] py-[15px]"
                  >
                    <span className="min-w-0 truncate text-[16px]">{v.title ?? v.video_id}</span>
                    <span className="mono shrink-0 text-[13px] text-[var(--color-muted)]">
                      {v.topic ?? t.common.dash} · {relativeTime(v.published_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-12 lg:w-[360px]">
          <Widget id="status" title={t.ops.statusTitle}>
            <SystemStatus initial={events} dbOk={dbHealthy} selection={selection} />
          </Widget>
          <Widget id="mission" title={t.ops.missionTitle}>
            <DailyMission
              publishedToday={mission.publishedToday}
              analyticsToday={mission.analyticsToday}
              learningToday={mission.learningToday}
            />
          </Widget>
          <Widget id="topics" title={t.dashboard.topTopics}>
            {topics.length === 0 ? (
              <EmptyState>{t.dashboard.noTopics}</EmptyState>
            ) : (
              <ul>
                {topics.map((tp) => (
                  <li
                    key={tp.topic}
                    className="row-sweep flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--color-panel-2)]"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm text-[var(--color-fg)]">{tp.topic}</div>
                      <div className="truncate text-[11px] font-light text-[var(--color-muted)]">{tp.reason}</div>
                    </div>
                    <div
                      className="mono shrink-0 text-lg font-semibold tabular-nums"
                      style={{ color: tp.score >= 50 ? "var(--color-ok)" : "var(--color-warn)" }}
                    >
                      {tp.score.toFixed(0)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Widget>
          <Widget id="quota" title={t.ops.advQuotaGaugeTitle}>
            <QuotaGauges
              view={quotaView}
              labels={{
                total: t.ops.advQuotaTotal,
                none: t.ops.advQuotaNone,
                noData: t.ops.advNoData,
                slotsSuffix: t.ops.advQuotaSlots,
                unmeasured: t.ops.advQuotaUnmeasured,
                hint: t.ops.advQuotaGaugeHint,
              }}
            />
          </Widget>
        </aside>
      </div>

      <Widget id="feed" title={t.ops.streamTitle}>
        <div className="h-[420px]">
          <ActivityFeed initial={events} selection={selection} />
        </div>
      </Widget>

      {/* ── The run as one line, the way the direction closes its screen ───── */}
      <PipelineStrip
        tones={tones}
        right={lastEventAt ? `${t.dashboard.latestRun} · ${relativeTime(lastEventAt)}` : null}
      />
    </div>
  );
}

/** A label above a figure, the way the direction sets its stat row. */
function Figure({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div>
      <div className="t-label">{label}</div>
      <div className="mt-3 text-[26px] font-semibold tabular-nums" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      {sub && <div className="mt-1.5 max-w-[22ch] truncate text-[12px] font-light text-[var(--color-muted)]">{sub}</div>}
    </div>
  );
}
