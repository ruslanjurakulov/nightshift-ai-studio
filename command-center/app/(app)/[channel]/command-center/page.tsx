import Link from "next/link";
import { createClient, getUser } from "@/lib/supabase/server";
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
import { isScoped, orgWide, scopeQuery } from "@/lib/channels";
import { isRunNowConfigured } from "@/lib/server/run-backend";
import { RunNowButton } from "@/components/agents/RunNowButton";
import { isOperator, resolveCurrentOrgRole } from "@/lib/auth/org-roles";
import { atLeast } from "@/lib/auth/roles";
import { fmt } from "@/lib/i18n";
import type { FeedbackSignalRow, MetricsSnapshotRow, SystemEventRow, TopicPerformanceRow, VideoRow } from "@/lib/types";
import { isToday, num, relativeTime, statusTone, storedMs } from "@/lib/format";
import { ownerDayStartMs } from "@/lib/owner-time";
import { BOT_KIND_PATTERN, ownerAlerts } from "@/lib/alert-count";
import { timed } from "@/lib/server/read-timeout";
import { heldOnly, uploadedOnly } from "@/lib/heldVideos";
import { OwnerGlance, type GlanceTile } from "@/components/dashboard/OwnerGlance";
import { agentLabel, agentSummary } from "@/lib/agent-names";
import { balanceStale, balanceTone, lowestProviderBalance, spendToday, workersAlive, workersTone, type SpendToday } from "@/lib/owner-glance";
import { formatUsdAmount } from "@/lib/number-format";
import type { BalanceRow } from "@/lib/billing";
import { WORKER_COLUMNS, coerceWorkers, type WorkerRow } from "@/lib/workers";
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
  const { t, locale } = await getDictionary();
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
  // Whose create attempt the hero's Run now is: with the id its idempotency key survives a reload of the tab (as a hash
  // only). Read only when the button shows.
  const producerId = canProduce ? ((await getUser())?.id ?? "") : "";
  // The Pipeline screen is the operator's console; nobody else is shown a link
  // the layout would bounce.
  const operator = await isOperator();
  const needsSetup = Boolean(org.supported && org.current && !org.current.is_default && channels.length === 0);

  const supabase = await createClient();
  let glanceInputs: {
    waiting: number | null;
    alertsCount: number | null;
    alive: ReturnType<typeof workersAlive> | null;
    low: ReturnType<typeof lowestProviderBalance>;
    /** The balance snapshots could not be read (as opposed to: no provider reports one). */
    balanceFailed: boolean;
    showBalance: boolean;
    /** Exact counts for the owner's two time-window figures; null = could not read. */
    failed24h: number | null;
    publishedToday: number | null;
    /** What was spent today (the platform's provider accounts), or null when the ledger could not be read. */
    spend: SpendToday | null;
  } | null = null;
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
    // Every read has a time limit (lib/server/read-timeout.ts): a backend that never answers ends in "unknown" with a
    // Retry after a few seconds, not a skeleton for ever.
    const [ev, vid, tp, snap, sg, videoIds] = await Promise.all([
      timed(scopeQuery(supabase.from("system_events").select("*"), scope, { nullIsGlobal: true }).order("ts", { ascending: false }).limit(200)),
      timed(uploadedOnly(scopeQuery(supabase.from("videos").select("*"), scope)).order("published_at", { ascending: false }).limit(50)),
      fetchTopicScores(supabase, scope, 6),
      timed(supabase.from("metrics_snapshots").select("*").order("snapshot_date", { ascending: false }).limit(200)),
      timed(scopeQuery(supabase.from("feedback_signals").select("*"), scope).order("analyzed_date", { ascending: false }).limit(200)),
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

  // The owner's phone strip (operator only; a customer's page is unchanged): the few things the owner needs
  // first, each from a read that already exists elsewhere (Billing's balance snapshots, Integrations' worker
  // heartbeats, Alerts' feed, the held videos Home counts). Light reads (a count, or the newest rows); a
  // failed one leaves its figure null = "unknown", never 0.
  if (operator && supabase) {
    const nowMs = Date.now();
    const since24 = new Date(nowMs - DAY_MS).toISOString();
    // "Today" is the owner's day (Tashkent), not the UTC day.
    const todayStart = new Date(ownerDayStartMs(nowMs)).toISOString();
    const [waitingRes, alertsRes, workersRes, balancesRes, failedRes, publishedRes, spendRes] = await Promise.all([
      timed(heldOnly(scopeQuery(supabase.from("videos").select("video_id", { count: "exact", head: true }), scope))),
      // The rows (kind, title, time), not a bare count: the bot's own bookkeeping rows are out and a repeated low-balance
      // row counts once (lib/alert-count.ts), which a head count cannot do.
      timed(
        scopeQuery(supabase.from("alert_events").select("kind,title,at"), orgWide(scope), { nullIsGlobal: true })
          .in("severity", ["warn", "critical"])
          .not("kind", "like", BOT_KIND_PATTERN)
          .gte("at", since24)
          .limit(500),
      ),
      timed(supabase.from("worker_status").select(WORKER_COLUMNS).order("updated_at", { ascending: false }).limit(50)),
      // The provider accounts are the platform's own: only in the operator's own organization (as Billing does).
      scope.includeGlobal
        ? timed(supabase.from("provider_balances").select("*").order("checked_at", { ascending: false }).limit(200))
        : Promise.resolve(null),
      // Exact counts: the newest-200 / newest-50 windows above undercount on a busy day (the 201st-newest failure).
      timed(
        scopeQuery(supabase.from("system_events").select("ts", { count: "exact", head: true }), scope, { nullIsGlobal: true })
          .or("status.ilike.failed,status.ilike.error")
          .gte("ts", since24),
      ),
      timed(uploadedOnly(scopeQuery(supabase.from("videos").select("video_id", { count: "exact", head: true }), scope)).gte("published_at", todayStart)),
      // Today's cost-ledger rows only (the provider accounts are the platform's: operator's own organization). One day of
      // rows, not the 90 days Billing reads; a day that fills the page is not summed (the figure would be a floor).
      scope.includeGlobal
        ? timed(supabase.from("video_costs").select("quantity,estimated_usd").gte("recorded_at", todayStart).limit(1000))
        : Promise.resolve(null),
    ]);
    const waiting = readFailed(waitingRes) ? null : (waitingRes.count ?? 0);
    const alertsCount = readFailed(alertsRes)
      ? null
      : ownerAlerts(((alertsRes.data ?? []) as { kind: string; title: string | null; at: string }[])).length;
    const workers: WorkerRow[] | null = workersRes.error ? null : coerceWorkers(workersRes.data);
    const alive = workers ? workersAlive(workers, Date.now()) : null;
    const balanceFailed = Boolean(balancesRes && balancesRes.error);
    const low =
      balancesRes && !balancesRes.error ? lowestProviderBalance((balancesRes.data ?? []) as BalanceRow[]) : null;
    glanceInputs = {
      waiting,
      alertsCount,
      alive,
      low,
      balanceFailed,
      showBalance: scope.includeGlobal,
      failed24h: readFailed(failedRes) ? null : (failedRes.count ?? 0),
      publishedToday: readFailed(publishedRes) ? null : (publishedRes.count ?? 0),
      spend:
        !spendRes || readFailed(spendRes) || ((spendRes.data as unknown[] | null)?.length ?? 0) >= 1000
          ? null
          : spendToday((spendRes.data ?? []) as { quantity: number | null; estimated_usd: number | null }[]),
    };
  }

  // A failed read leaves these arrays empty; the figures below are null
  // ("unknown") in that case, never a 0.
  // The owner's figures are exact counts (above); a customer's page keeps the window of the newest rows it already read.
  const publishedToday = glanceInputs
    ? glanceInputs.publishedToday
    : knownCount(videos.filter((v) => isToday(v.published_at)).length, videosOk);
  const errors24h = glanceInputs
    ? glanceInputs.failed24h
    : knownCount(
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
      ? `${t.dashboard.latestRun} · ${relativeTime(lastEventAt, locale)}`
      : t.dashboard.noRunsYet;

  // The owner's strip, most urgent first: money, failures, what waits for them, alerts, workers, output.
  const tiles: GlanceTile[] = [];
  if (glanceInputs) {
    const gl = glanceInputs;
    const flag = (n: number | null, bad: GlanceTile["tone"]): GlanceTile["tone"] => (n === null ? "idle" : n > 0 ? bad : "ok");
    if (gl.showBalance) {
      const stale = gl.low ? balanceStale(gl.low.checkedAt, Date.now()) : false;
      tiles.push({
        key: "balance",
        href: path("/billing"),
        label: t.ownerShell.gBalance,
        value: gl.low ? fmt(t.ownerShell.gBalanceLeft, { pct: gl.low.pct }) : null,
        sub: gl.low
          ? `${gl.low.name} · ${stale ? t.ownerShell.gBalanceStale : relativeTime(gl.low.checkedAt, locale)}`
          : gl.balanceFailed
            ? t.common.couldNotRead
            : t.ownerShell.gBalanceNone,
        tone: gl.low ? balanceTone(gl.low.pct, stale) : "idle",
      });
    }
    if (gl.showBalance) {
      // The money line: what was spent today. A day with only unpriced rows has no figure; some unpriced rows make it a floor.
      const sp = gl.spend;
      tiles.unshift({
        key: "spend",
        href: path("/billing"),
        label: t.ownerShell.gSpendToday,
        value: sp && sp.usd !== null ? formatUsdAmount(sp.usd, locale, 2, 2) : null,
        sub: !sp ? t.common.couldNotRead : sp.usd === null ? t.ownerShell.gSpendNotPriced : sp.unpriced > 0 ? t.ownerShell.gSpendPartial : undefined,
        tone: "idle",
        wide: true,
      });
    }
    // An unknown figure carries no confident words under it ("none", "idle" would say there is nothing); a system that has
    // recorded nothing at all is "idle", not a green all-clear.
    const nothingYet = eventsOk && events.length === 0;
    tiles.push(
      {
        key: "failed",
        href: path("/errors"),
        label: t.ownerShell.gFailed,
        value: errors24h === null ? null : num(errors24h),
        sub: errors24h === null ? t.common.couldNotRead : errors24h ? t.dashboard.needsAttention : nothingYet ? t.ownerTruth.noEventsYet : t.common.none,
        tone: errors24h === 0 && nothingYet ? "idle" : flag(errors24h, "fail"),
      },
      {
        key: "waiting",
        href: path("/videos"),
        label: t.ownerShell.gWaiting,
        value: gl.waiting === null ? null : num(gl.waiting),
        sub: gl.waiting === null ? t.common.couldNotRead : gl.waiting ? t.ownerShell.gWaitingSub : t.common.none,
        tone: flag(gl.waiting, "warn"),
      },
      {
        key: "alerts",
        href: path("/alerts"),
        label: t.ownerShell.gAlerts,
        value: gl.alertsCount === null ? null : num(gl.alertsCount),
        sub: gl.alertsCount === null ? t.common.couldNotRead : gl.alertsCount ? t.ownerShell.gAlertsSub : t.common.none,
        tone: flag(gl.alertsCount, "warn"),
      },
      {
        key: "workers",
        href: path("/integrations"),
        label: t.ownerShell.gWorkers,
        value: gl.alive ? `${gl.alive.alive}/${gl.alive.total}` : null,
        sub: !gl.alive
          ? t.common.couldNotRead
          : gl.alive.total === 0
            ? t.ownerShell.gWorkersNone
            : [
                gl.alive.silent > 0 ? fmt(t.ownerShell.gWorkersSilent, { n: gl.alive.silent }) : "",
                gl.alive.stopped > 0 ? fmt(t.ownerShell.gWorkersStopped, { n: gl.alive.stopped }) : "",
              ]
                .filter(Boolean)
                .join(" · ") || t.ownerShell.gWorkersAll,
        tone: workersTone(gl.alive),
      },
      {
        key: "published",
        href: path("/videos"),
        label: t.dashboard.publishedToday,
        value: publishedToday === null ? null : num(publishedToday),
        sub: publishedToday === null ? t.common.couldNotRead : undefined,
        tone: "idle",
      },
      {
        // Humanized names, so the agent-name work is on the phone too (the figures row is desktop-only).
        key: "agents",
        href: path("/agents"),
        label: t.dashboard.activeAgents,
        value: activeAgents === null ? null : num(activeAgents),
        sub:
          activeAgents === null
            ? t.common.couldNotRead
            : runningAgents.length
              ? agentSummary(runningAgents, t.ownerShell.agentNames)
              : t.common.idle,
        tone: "idle",
        wide: true,
      },
    );
  }

  return (
    <div className="rhythm ns-open g5-page stagger-enter">
      <PageHeader icon="autonomy" title={t.dashboard.title} subtitle={t.dashboard.subtitle} actions={<CustomizeButton />} compactPhone={operator} />

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

      {tiles.length > 0 && (
        <OwnerGlance
          label={t.ownerShell.glanceLabel}
          health={{ tone: lamp, text: lampLabel, detail: null, live: chip === "healthy" }}
          tiles={tiles}
          unknown={t.common.unknown}
        />
      )}
      {/* Some figure could not be read (a failed or timed-out read): one Retry for the strip, not a tile that sits on "unknown". */}
      {tiles.some((x) => x.value === null) && (
        <div className="lg:hidden">
          <ErrorState compact />
        </div>
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

            {/* The owner's phone shows these in the strip above (OwnerGlance); the figures keep their place from `lg`. */}
            <div className={operator ? "max-lg:hidden" : undefined}>
            <div className="g5-figs" style={{ marginTop: 28 }}>
              <Figure label={t.dashboard.publishedToday} value={publishedToday} unknown={t.common.unknown} unknownSub={t.common.couldNotRead} />
              <Figure
                label={t.dashboard.activeAgents}
                value={activeAgents}
                unknown={t.common.unknown}
                unknownSub={t.common.couldNotRead}
                sub={runningAgents.length ? runningAgents.map((a) => agentLabel(a, t.ownerShell.agentNames)).join(", ") : t.common.idle}
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
                    userId={producerId}
                    orgId={org.supported && org.current ? org.current.id : null}
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
                      {v.topic ?? t.common.dash} · {relativeTime(v.published_at, locale)}
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
        right={lastEventAt ? `${t.dashboard.latestRun} · ${relativeTime(lastEventAt, locale)}` : null}
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
