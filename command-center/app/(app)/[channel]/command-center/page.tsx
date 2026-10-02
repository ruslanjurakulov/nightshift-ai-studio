import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getChannelPath } from "@/lib/channels-path-server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { EmptyState } from "@/components/ui";
import { StatusLamp } from "@/components/ui/StatusLamp";
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
import { fetchScopedVideoIds, fetchTopicScores, getChannelContext } from "@/lib/channels-server";
import { isScoped, scopeQuery } from "@/lib/channels";
import { isRunNowConfigured } from "@/lib/server/run-backend";
import { RunNowButton } from "@/components/agents/RunNowButton";
import { isOperator, resolveCurrentOrgRole } from "@/lib/auth/org-roles";
import { atLeast } from "@/lib/auth/roles";
import { fmt } from "@/lib/i18n";
import type { FeedbackSignalRow, MetricsSnapshotRow, SystemEventRow, TopicPerformanceRow, VideoRow } from "@/lib/types";
import { isToday, num, relativeTime, statusTone, storedMs } from "@/lib/format";
import { uploadedOnly } from "@/lib/heldVideos";
import { getOrgContext } from "@/lib/orgs-server";
import { WELCOME_PATH } from "@/lib/public-paths";
import { ErrorState } from "@/components/ReadError";
import { commandCenterChip, knownCount, readFailed } from "@/lib/readState";

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
  const { selection, channels, scope } = await getChannelContext();
  // The primary "Produce a video" action needs one verified channel and the
  // run backend's wiring (GitHub dispatch, or the render_jobs queue); when either is missing the hero keeps its
  // navigation buttons only, rather than showing a dead control.
  const scopedChannel = isScoped(selection)
    ? channels.find((c) => c.channel_id === selection)
    : undefined;
  // The hero's Run now shows only when a run is possible AND the caller is an
  // owner/admin of the channel's organization — what the route requires.
  const canProduce =
    Boolean(scopedChannel) && isRunNowConfigured && atLeast(await resolveCurrentOrgRole(), "admin");
  // A customer workspace with no channel yet has nothing to show here; point
  // back to the first-run checklist rather than leaving a page of zeros. The
  // operator's own organization never sees it.
  const org = await getOrgContext();
  // The Pipeline screen is the operator's console; nobody else is shown a link
  // the layout would bounce.
  const operator = await isOperator();
  const needsSetup = Boolean(org.supported && org.current && !org.current.is_default && channels.length === 0);

  const supabase = await createClient();
  let events: SystemEventRow[] = [];
  let videos: VideoRow[] = [];
  let topics: TopicPerformanceRow[] = [];
  let snapshots: MetricsSnapshotRow[] = [];
  let signals: FeedbackSignalRow[] = [];
  let dbHealthy = true;
  // Per-source read state: a figure is a number only when ITS read succeeded.
  let eventsOk = true;
  let videosOk = true;
  let snapshotsOk = true;
  let signalsOk = true;

  if (supabase) {
    const [ev, vid, tp, snap, sg, videoIds] = await Promise.all([
      scopeQuery(supabase.from("system_events").select("*"), scope, { nullIsGlobal: true }).order("ts", { ascending: false }).limit(200),
      uploadedOnly(scopeQuery(supabase.from("videos").select("*"), scope)).order("published_at", { ascending: false }).limit(50),
      fetchTopicScores(supabase, scope, 6),
      supabase.from("metrics_snapshots").select("*").order("snapshot_date", { ascending: false }).limit(200),
      scopeQuery(supabase.from("feedback_signals").select("*"), scope).order("analyzed_date", { ascending: false }).limit(200),
      fetchScopedVideoIds(supabase, scope),
    ]);
    eventsOk = !readFailed(ev);
    videosOk = !readFailed(vid);
    snapshotsOk = !readFailed(snap);
    signalsOk = !readFailed(sg);
    if (!eventsOk || !videosOk) dbHealthy = false;
    events = (ev.data as SystemEventRow[]) ?? [];
    videos = (vid.data as VideoRow[]) ?? [];
    topics = tp;
    // Snapshots carry no channel: "analysed today" counts only the scope's
    // own videos, not every tenant's the database would hand a platform admin.
    snapshots = ((snap.data as MetricsSnapshotRow[]) ?? []).filter(
      (s) => !videoIds || videoIds.has(s.video_id),
    );
    signals = (sg.data as FeedbackSignalRow[]) ?? [];
  }

  // A failed read leaves these arrays empty; the figures below are null
  // ("unknown") in that case, never a 0.
  const publishedToday = knownCount(videos.filter((v) => isToday(v.published_at)).length, videosOk);
  const errors24h = knownCount(
    events.filter((e) => statusTone(e.status) === "fail" && Date.now() - (storedMs(e.ts) ?? 0) < DAY_MS).length,
    eventsOk,
  );
  const runningAgents = Array.from(
    new Set(events.filter((e) => statusTone(e.status) === "run").map((e) => e.agent)),
  ).filter(Boolean);
  const activeAgents = knownCount(runningAgents.length, eventsOk);
  const lastEventAt = events[0]?.ts ?? null;
  const chip = commandCenterChip({ readable: dbHealthy, errors24h, events: events.length });
  const recentVideos = videos.slice(0, 6);
  const mission = dailyMission(videos, snapshots, signals);
  const missionView = {
    publishedToday: knownCount(mission.publishedToday, videosOk),
    analyticsToday: knownCount(mission.analyticsToday, snapshotsOk),
    learningToday: knownCount(mission.learningToday, signalsOk),
  };
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
  const lead = !eventsOk
    ? t.dashboard.leadUnknown
    : next
      ? fmt(t.dashboard.leadNext, { s: STAGE_LABEL[next.key] })
      : videos.length
        ? t.dashboard.leadDone
        : t.dashboard.leadIdle;

  return (
    <div className="rhythm stagger-enter">
      {needsSetup && (
        <div className="panel flex flex-wrap items-center justify-between gap-4 p-5">
          <div className="min-w-0">
            <h2 className="t-section">{t.signup.finishSetup}</h2>
            <p className="mt-1 text-[13px] text-[var(--color-muted)]">{t.signup.finishSetupBody}</p>
          </div>
          <Link href={WELCOME_PATH} className="btn-primary text-[13px]">
            {t.signup.finishSetup} →
          </Link>
        </div>
      )}
      {/* ── The run, and the instruments beside it ─────────────────────────── */}
      <div className="flex flex-col gap-14 lg:flex-row lg:gap-20">
        <div className="flex min-w-0 flex-1 flex-col gap-10">
          <div>
            <div className="t-label">
              {!eventsOk
                ? t.dashboard.runUnknown
                : lastEventAt
                  ? `${t.dashboard.latestRun} · ${relativeTime(lastEventAt)}`
                  : t.dashboard.noRunsYet}
            </div>
            <h1 className="t-hero mt-5">{!videosOk ? t.dashboard.heroUnknown : (latest?.title ?? t.dashboard.heroIdle)}</h1>
            <p className="t-lead mt-6">{lead}</p>
          </div>

          <div className="flex flex-wrap gap-x-14 gap-y-8">
            <Figure label={t.dashboard.publishedToday} value={publishedToday} unknown={t.common.unknown} unknownSub={t.common.couldNotRead} />
            <Figure
              label={t.dashboard.activeAgents}
              value={activeAgents}
              unknown={t.common.unknown}
              unknownSub={t.common.couldNotRead}
              sub={runningAgents.length ? runningAgents.join(", ") : t.common.idle}
              tone={runningAgents.length ? "var(--color-warn)" : undefined}
            />
            <Figure
              label={t.dashboard.errors24h}
              value={errors24h}
              unknown={t.common.unknown}
              unknownSub={t.common.couldNotRead}
              sub={errors24h ? t.dashboard.needsAttention : t.common.none}
              tone={errors24h ? "var(--color-fail)" : "var(--color-ok)"}
            />
            <Figure
              label={t.dashboard.videos}
              value={videosOk ? (videos.length >= 8 ? null : videos.length) : null}
              // A library of 8+ was never a count ("showing latest 8"): that is
              // N/A, not unknown. Only a failed read is "unknown".
              unknown={videosOk ? t.common.na : t.common.unknown}
              unknownSub={videosOk ? undefined : t.common.couldNotRead}
              sub={videos.length >= 8 ? t.dashboard.showingLatest8 : t.dashboard.inLibrary}
            />
          </div>

          <div className="flex flex-wrap items-center gap-4">
            {canProduce && scopedChannel && (
              <RunNowButton
                variant="inline"
                channelId={scopedChannel.channel_id}
                githubConfigured={isRunNowConfigured}
                label={t.dashboard.produce}
              />
            )}
            {operator && (
            <Link
              href={path("/pipeline")}
              className={`${canProduce ? "btn-quiet" : "btn-primary"} text-[14px]`}
            >
              {t.dashboard.openPipeline}
              <span className="btn-arrow" aria-hidden>
                →
              </span>
            </Link>
            )}
            <Link href={path("/videos")} className="btn-quiet text-[14px]">
              {t.dashboard.openVideos}
            </Link>
            <CustomizeButton />
            <StatusLamp
              tone={chip === "healthy" ? "ok" : chip === "attention" ? "fail" : chip === "unreadable" ? "warn" : "idle"}
              label={
                chip === "healthy"
                  ? t.dashboard.systemHealthy
                  : chip === "attention"
                    ? t.dashboard.attention
                    : chip === "unreadable"
                      ? t.dashboard.unreadable
                      : t.dashboard.noActivity
              }
              live={chip === "healthy"}
            />
          </div>

          <div>
            <div className="t-label mb-5">{t.dashboard.recentVideos}</div>
            {!videosOk ? (
              <ErrorState compact />
            ) : recentVideos.length === 0 ? (
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
            <SystemStatus initial={events} dbOk={dbHealthy} scope={scope} />
          </Widget>
          <Widget id="mission" title={t.ops.missionTitle}>
            <DailyMission
              publishedToday={missionView.publishedToday}
              analyticsToday={missionView.analyticsToday}
              learningToday={missionView.learningToday}
            />
          </Widget>
          <Widget id="topics" title={t.dashboard.topTopics}>
            {!dbHealthy ? (
              <ErrorState compact />
            ) : topics.length === 0 ? (
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
            {!eventsOk ? (
              <ErrorState compact />
            ) : (
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
            )}
          </Widget>
        </aside>
      </div>

      <Widget id="feed" title={t.ops.streamTitle}>
        <div className={eventsOk ? "h-[420px]" : undefined}>
          {eventsOk ? <ActivityFeed initial={events} scope={scope} /> : <ErrorState />}
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
function Figure({
  label,
  value,
  sub,
  tone,
  unknown,
  unknownSub,
}: {
  label: string;
  /** null = no number to show (a failed read, or a count that was never one). */
  value: number | null;
  sub?: string;
  tone?: string;
  /** What a null value reads as ("unknown", or N/A). */
  unknown: string;
  unknownSub?: string;
}) {
  const known = value !== null;
  const shownSub = known ? sub : unknownSub ?? sub;
  return (
    <div>
      <div className="t-label">{label}</div>
      <div
        className="mt-3 text-[26px] font-semibold tabular-nums"
        style={known && tone ? { color: tone } : known ? undefined : { color: "var(--color-muted)" }}
      >
        {known ? num(value) : unknown}
      </div>
      {shownSub && <div className="mt-1.5 max-w-[22ch] truncate text-[12px] font-light text-[var(--color-muted)]">{shownSub}</div>}
    </div>
  );
}
