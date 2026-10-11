import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getChannelPath } from "@/lib/channels-path-server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { StateBlock } from "@/components/states/StateBlock";
import "../../app-pages-g5.css";
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

  const lamp = chip === "healthy" ? "ok" : chip === "attention" ? "fail" : chip === "unreadable" ? "warn" : "idle";
  const lampLabel =
    chip === "healthy"
      ? t.dashboard.systemHealthy
      : chip === "attention"
        ? t.dashboard.attention
        : chip === "unreadable"
          ? t.dashboard.unreadable
          : t.dashboard.noActivity;
  // One lit desk and one filled key per page: the finish-setup banner when it shows, otherwise the run.
  const runDesk = !needsSetup;
  const runLabel = !eventsOk
    ? t.dashboard.runUnknown
    : lastEventAt
      ? `${t.dashboard.latestRun} · ${relativeTime(lastEventAt)}`
      : t.dashboard.noRunsYet;

  return (
    <div className="rhythm ns-open g5-page stagger-enter">
      <PageHeader icon="autonomy" title={t.dashboard.title} subtitle={t.dashboard.subtitle} actions={<CustomizeButton />} />

      {needsSetup && (
        <section className="panel ns-desk" aria-labelledby="cc-setup">
          <div className="flex flex-wrap items-center justify-between gap-5">
            <div className="min-w-0">
              <h2 id="cc-setup" className="g5-h">
                {t.signup.finishSetup}
              </h2>
              <p className="g5-sub">{t.signup.finishSetupBody}</p>
            </div>
            <Link href={WELCOME_PATH} className="btn-primary">
              {t.signup.finishSetup}
              <span className="btn-arrow" aria-hidden>
                →
              </span>
            </Link>
          </div>
        </section>
      )}

      {/* ── The run, and the instruments beside it ─────────────────────────── */}
      <div className="g5-cc">
        <div className="g5-cc-main">
          <section className={runDesk ? "panel ns-desk" : "panel"} aria-labelledby="cc-run">
            <div className="g5-sechead">
              <span className="g5-k">{runLabel}</span>
              <StatusLamp tone={lamp} label={lampLabel} live={chip === "healthy"} />
            </div>
            <h2 id="cc-run" className="g5-run-title">
              {!videosOk ? t.dashboard.heroUnknown : (latest?.title ?? t.dashboard.heroIdle)}
            </h2>
            <p className="g5-run-lead">{lead}</p>

            <div className="g5-figs" style={{ marginTop: 28 }}>
              <Figure label={t.dashboard.publishedToday} value={publishedToday} unknown={t.common.unknown} unknownSub={t.common.couldNotRead} />
              <Figure
                label={t.dashboard.activeAgents}
                value={activeAgents}
                unknown={t.common.unknown}
                unknownSub={t.common.couldNotRead}
                sub={runningAgents.length ? runningAgents.join(", ") : t.common.idle}
                tone={runningAgents.length ? "var(--ns-amber-ink)" : undefined}
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

            <div className="g5-actions" style={{ marginTop: 28 }}>
              {canProduce && scopedChannel && (
                // Same visibility as ever. While the finish-setup key is the page's filled primary this one is drawn quiet (styling only).
                <div className={runDesk ? undefined : "g5-quiet-keys"}>
                  <RunNowButton
                    variant="inline"
                    channelId={scopedChannel.channel_id}
                    githubConfigured={isRunNowConfigured}
                    label={t.dashboard.produce}
                  />
                </div>
              )}
              {operator && (
                <Link href={path("/pipeline")} className={`${canProduce || !runDesk ? "btn-quiet" : "btn-primary"} text-sm`}>
                  {t.dashboard.openPipeline}
                  <span className="btn-arrow" aria-hidden>
                    →
                  </span>
                </Link>
              )}
              <Link href={path("/videos")} className="btn-quiet text-sm">
                {t.dashboard.openVideos}
              </Link>
            </div>
          </section>

          <section className="panel" aria-labelledby="cc-recent">
            <div className="g5-sechead">
              <h2 id="cc-recent" className="g5-h">
                {t.dashboard.recentVideos}
              </h2>
            </div>
            {!videosOk ? (
              <ErrorState compact />
            ) : recentVideos.length === 0 ? (
              <StateBlock
                tone="idle"
                actions={
                  <Link href={path("/create")} className="btn-quiet">
                    {t.dashboard.produce}
                  </Link>
                }
              >
                {t.dashboard.noVideos}
              </StateBlock>
            ) : (
              <ul className="g5-rows">
                {recentVideos.map((v) => (
                  <li key={v.video_id} className="g5-row" style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
                    <span className="g5-row-title">{v.title ?? v.video_id}</span>
                    <span className="g5-row-meta tnum" style={{ margin: 0, textAlign: "right" }}>
                      {v.topic ?? t.common.dash} · {relativeTime(v.published_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <Widget id="feed" title={t.ops.streamTitle}>
            {eventsOk ? <ActivityFeed initial={events} scope={scope} /> : <ErrorState />}
          </Widget>
        </div>

        <aside className="g5-cc-side">
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
              <StateBlock tone="idle" compact>
                {t.dashboard.noTopics}
              </StateBlock>
            ) : (
              <ul className="g5-topics">
                {topics.map((tp) => (
                  <li key={tp.topic} className="g5-topic">
                    <div className="min-w-0">
                      <div className="g5-row-title">{tp.topic}</div>
                      <div className="g5-row-meta">{tp.reason}</div>
                    </div>
                    <div
                      className="tnum shrink-0 text-lg font-semibold tabular-nums"
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

      {/* ── The run as one line ───────────────────────────────────────────── */}
      <PipelineStrip
        tones={tones}
        right={lastEventAt ? `${t.dashboard.latestRun} · ${relativeTime(lastEventAt)}` : null}
      />
    </div>
  );
}

/** A label above a figure, the way the pages set their stat rows. */
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
      <div className="g5-k">{label}</div>
      <div
        className={known ? "g5-fig-v" : "g5-fig-v g5-unknown"}
        style={known && tone ? { color: tone } : known ? undefined : { color: "var(--color-muted)" }}
      >
        {known ? num(value) : unknown}
      </div>
      {shownSub && <div className="g5-fig-sub">{shownSub}</div>}
    </div>
  );
}
