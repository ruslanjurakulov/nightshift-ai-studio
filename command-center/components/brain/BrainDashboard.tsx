"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Clock3, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { formatNumber } from "@/lib/number-format";
import { formatDay, formatDayTime } from "@/lib/date-format";
import { pluralText, type PluralForms } from "@/lib/plural";
import { StateBlock } from "@/components/states/StateBlock";
import {
  QUESTIONS_THEME,
  SPEND_TOOLS,
  forecast,
  minutesAgo,
  sparkPoints,
  usedShare,
  warnUsed,
  type BrainFacts,
  type BrainFactsRead,
  type ChannelRead,
  type DayPoint,
} from "@/lib/brain/dashboard";

/** The minute hand: "fetched N min ago" stays true while the page is open, without a reload. It starts at the server's
 *  render time so the first paint matches the server's HTML (no hydration mismatch), then follows the clock. */
function useNow(start: string): number {
  const [now, setNow] = useState(() => {
    const t = Date.parse(start);
    return Number.isNaN(t) ? 0 : t;
  });
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);
  return now;
}

/** The app's own formatters: raw Intl renders Uzbek differently in Node and Chromium, which is a hydration mismatch. */
function useFormat(locale: string) {
  const n = (v: number, maxFraction = 2) => formatNumber(v, locale, maxFraction);
  const date = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? iso : formatDay(new Date(t), locale, "UTC");
  };
  return { n, date };
}

/** The plural form by the count, the count itself in the app's number format (pluralText alone writes a bare 12345). */
function viewsText(forms: PluralForms, v: number, locale: string): string {
  const shell = Object.fromEntries(Object.entries(forms).map(([k, f]) => [k, f.replace("{n}", "{count}")])) as PluralForms;
  return fmt(pluralText(shell, v, locale), { count: formatNumber(v, locale) });
}

/** An unknown or hidden figure is a word, not a number: small and muted, so it never reads as a measurement. */
function Missing({ children }: { children: React.ReactNode }) {
  return <span className="text-sm font-normal text-[var(--color-muted)]">{children}</span>;
}

/** Every number read from somewhere else says when it was read. */
function Fetched({ iso, now }: { iso: string | null; now: number }) {
  const { t } = useI18n();
  const td = t.brainDash;
  const m = minutesAgo(iso, now);
  return (
    <span className="inline-flex items-center gap-1 text-xs text-[var(--color-muted)]" data-fetched={m ?? "unknown"}>
      <Clock3 aria-hidden className="size-3.5" />
      {m === null ? td.fetchedUnknown : m === 0 ? td.fetchedNow : fmt(td.fetched, { n: m })}
    </span>
  );
}

function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel flex min-w-0 flex-col gap-4 p-4 sm:p-5" aria-label={title}>
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

function Figure({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="t-label">{label}</div>
      <div className="t-figure break-words">{value}</div>
      {sub ? <div className="text-xs text-[var(--color-muted)]">{sub}</div> : null}
    </div>
  );
}

/** A subtle 14-day line: no axes, no gridlines, one stroke and a soft fill. A quiet fortnight stays flat. */
function Spark({ daily, label }: { daily: readonly DayPoint[]; label: string }) {
  const pts = sparkPoints(daily);
  if (pts.length < 2) return null;
  const w = 280;
  const h = 56;
  const step = w / (pts.length - 1);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - 4 - p * (h - 8)).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} className="h-14 w-full" preserveAspectRatio="none" data-spark="">
      <path d={`${line} L${w},${h} L0,${h} Z`} fill="var(--color-primary)" opacity={0.08} />
      <path d={line} fill="none" stroke="var(--color-primary)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Note({ tone = "muted", children }: { tone?: "muted" | "warn" | "fail"; children: React.ReactNode }) {
  const color = tone === "warn" ? "var(--color-warn)" : tone === "fail" ? "var(--color-fail)" : "var(--color-muted)";
  return (
    <p className="m-0 flex min-w-0 items-start gap-2 break-words text-sm" style={{ color }}>
      {tone !== "muted" ? <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" /> : null}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** "Ask for fresh numbers": one request row (S10's research_request_refresh) and nothing else; the reading is the worker's. */
function RefreshKey({ channelId, canRefresh }: { channelId: string; canRefresh: boolean }) {
  const { t, locale } = useI18n();
  const tc = t.brainDash.channel;
  const router = useRouter();
  const busy = useRef(false);
  const [state, setState] = useState<"idle" | "busy" | "asked" | "recent" | "limit" | "forbidden" | "not_connected" | "failed">("idle");
  const [nextAt, setNextAt] = useState<string | null>(null);
  async function ask() {
    if (busy.current) return;
    busy.current = true;
    setState("busy");
    try {
      const res = await fetch("/api/brain/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: channelId }),
      });
      const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string; next_at?: string };
      setNextAt(typeof body.next_at === "string" ? body.next_at : null);
      setState(
        res.ok
          ? body.status === "recent" ? "recent" : "asked"
          : body.error === "daily_limit" ? "limit"
          : body.error === "forbidden" ? "forbidden"
          : body.error === "not_connected" ? "not_connected"
          : "failed",
      );
      if (res.ok) router.refresh();
    } catch {
      setState("failed");
    } finally {
      busy.current = false;
    }
  }
  // Below editor the route refuses (S10's 42501), so the key is not offered; the sentence says who can ask.
  if (!canRefresh) return <p className="m-0 text-xs text-[var(--color-muted)]">{tc.refreshForbidden}</p>;
  // A request is open (or the numbers are fresh): a second press would only return the same answer.
  const settled = state === "asked" || state === "recent" || state === "limit" || state === "forbidden" || state === "not_connected";
  const bad = state === "failed" || state === "limit" || state === "forbidden" || state === "not_connected";
  const next = nextAt && !Number.isNaN(Date.parse(nextAt)) ? formatDayTime(new Date(nextAt), locale) : null;
  const message =
    state === "asked" ? tc.refreshAsked
    : state === "recent" ? (next ? fmt(tc.refreshRecentUntil, { time: next }) : tc.refreshRecent)
    : state === "not_connected" ? tc.notConnected
    : state === "limit" ? tc.budget
    : state === "forbidden" ? tc.refreshForbidden
    : state === "failed" ? tc.refreshFailed
    : "";
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <button
        type="button"
        className="btn-quiet min-h-11 text-sm aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        // aria-disabled, not disabled: a disabled button drops keyboard focus to <body>. The busy ref and this guard refuse
        // the second press instead.
        onClick={() => {
          if (state !== "busy" && !settled) void ask();
        }}
        aria-disabled={state === "busy" || settled}
        aria-busy={state === "busy"}
        data-refresh={state}
      >
        <RefreshCw aria-hidden className={`size-4 ${state === "busy" ? "motion-safe:animate-spin" : ""}`} />
        {tc.refresh}
      </button>
      <span
        role="status"
        aria-live="polite"
        className="inline-flex items-start gap-1.5 text-xs"
        style={{ color: state === "failed" ? "var(--color-fail)" : bad ? "var(--color-warn)" : "var(--color-muted)" }}
      >
        {bad ? <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : null}
        {message}
      </span>
    </div>
  );
}

/** "Try again" re-reads the page on the server; it asks nothing else. */
function RetryKey() {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <button type="button" className="btn-quiet min-h-11 text-sm" onClick={() => router.refresh()}>
      <RefreshCw aria-hidden className="size-4" />
      {t.brainDash.retry}
    </button>
  );
}

function ChannelCard({ read, now, canRefresh }: { read: ChannelRead; now: number; canRefresh: boolean }) {
  const { t, locale } = useI18n();
  const td = t.brainDash;
  const tc = td.channel;
  const path = useChannelPath();
  const { n, date } = useFormat(locale);
  const fetchedAt = "fetchedAt" in read ? read.fetchedAt : null;
  const channelId = "channelId" in read ? read.channelId : null;
  const missing = (v: number | null) => (v === null ? <Missing>{td.unknown}</Missing> : n(v));
  const word = (v: number | null) => (v === null ? td.unknown : n(v));
  const connect = (
    <Link href={path("/channels")} className="btn-quiet min-h-11 text-sm no-underline">
      {tc.connect}
    </Link>
  );
  return (
    <Card title={read.state === "ok" && read.title ? `${tc.title} · ${read.title}` : tc.title} right={"fetchedAt" in read ? <Fetched iso={fetchedAt} now={now} /> : null}>
      {read.state === "ok" ? (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Figure label={tc.subscribers} value={read.subscribersHidden ? <Missing>{td.hidden}</Missing> : missing(read.subscribers)} />
            <Figure label={tc.totalViews} value={missing(read.views)} />
            <Figure label={tc.videoCount} value={missing(read.videoCount)} />
          </div>
          {read.analytics ? (
            <div className="flex flex-col gap-2 rounded-[var(--ns-r-key)] border border-[var(--color-border)] p-3" data-analytics="">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="t-label">{tc.analytics}</span>
                {read.analytics.dataThrough ? (
                  <span className="text-xs text-[var(--color-muted)]">{fmt(tc.dataThrough, { date: date(read.analytics.dataThrough) })}</span>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Figure label={tc.views} value={missing(read.analytics.views)} />
                <Figure label={tc.minutesWatched} value={missing(read.analytics.minutesWatched)} />
                <Figure
                  label={tc.subsChange}
                  value={
                    <>
                      <span className="whitespace-nowrap">+{word(read.analytics.subsGained)}</span>{" "}
                      <span className="whitespace-nowrap">· −{word(read.analytics.subsLost)}</span>
                    </>
                  }
                />
              </div>
            </div>
          ) : null}
          {read.topUploads.length ? (
            <div className="flex flex-col gap-1">
              <div className="t-label">{tc.topVideos}</div>
              <ol className="m-0 flex list-none flex-col gap-1 p-0">
                {read.topUploads.map((v) => (
                  <li key={v.videoId} className="flex min-w-0 justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate" title={v.title ?? v.videoId}>{v.title ?? v.videoId}</span>
                    {v.privacy && v.privacy !== "public" ? (
                      <span className="shrink-0 rounded-full border border-[var(--color-border)] px-1.5 text-[11px] text-[var(--color-muted)]" data-privacy={v.privacy}>
                        {tc.privacy[v.privacy]}
                      </span>
                    ) : null}
                    <span className="ml-auto shrink-0 tabular-nums text-[var(--color-muted)]">
                      {v.views === null ? td.unknown : viewsText(t.brainDash.projects.views, v.views, locale)}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {read.themes.length ? (
            <div className="flex flex-col gap-1.5">
              <div className="t-label">{tc.themes}</div>
              <ul className="m-0 flex flex-wrap gap-1.5 p-0">
                {read.themes.map((th) => (
                  <li key={th.label} className="list-none rounded-full border border-[var(--color-border)] px-2.5 py-1 text-xs">
                    {th.label === QUESTIONS_THEME ? tc.questions : th.label}
                    {th.count !== null ? (
                      <span className="ml-1 tabular-nums text-[var(--color-muted)]">
                        <span className="sr-only">, </span>
                        {n(th.count)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className="m-0 text-xs text-[var(--color-muted)]">{tc.themesSource}</p>
            </div>
          ) : null}
        </>
      ) : read.state === "not_connected" ? (
        <StateBlock compact actions={connect}>{tc.notConnected}</StateBlock>
      ) : read.state === "budget_exhausted" ? (
        <StateBlock compact tone="warn">{tc.budget}</StateBlock>
      ) : read.state === "refreshing" ? (
        <Note>{tc.refreshing}</Note>
      ) : read.state === "no_data" ? (
        <Note>{tc.noData}</Note>
      ) : read.state === "failed" ? (
        <StateBlock compact tone="fail" role="alert" actions={<RetryKey />}>{td.readFailed}</StateBlock>
      ) : read.state === "pick_channel" ? (
        <Note>{tc.pickChannel}</Note>
      ) : read.state === "no_channel" ? (
        <StateBlock compact actions={connect}>{tc.noChannel}</StateBlock>
      ) : (
        <Note>{tc.waiting}</Note>
      )}
      {/* Only the codes whose fix the state's own sentence does not already say. */}
      {"remedy" in read && (read.remedy === "token_expired" || read.remedy === "not_configured") ? (
        <StateBlock
          compact
          tone="warn"
          data-remedy={read.remedy}
          actions={read.remedy === "token_expired" ? connect : undefined}
        >
          {tc.remedy[read.remedy]}
        </StateBlock>
      ) : null}
      {/* Out of today's reading budget, a press could only be refused, so it is not offered. */}
      {channelId && read.state !== "not_connected" && read.state !== "budget_exhausted" ? (
        <RefreshKey channelId={channelId} canRefresh={canRefresh} />
      ) : null}
      <p className="m-0 text-xs text-[var(--color-muted)]">{tc.lag}</p>
    </Card>
  );
}

function CreditsCard({ facts, now }: { facts: BrainFacts; now: number }) {
  const { t, locale } = useI18n();
  const td = t.brainDash;
  const tc = td.credits;
  const path = useChannelPath();
  const { n, date } = useFormat(locale);
  const f = forecast(facts, now);
  const share = usedShare(facts.plan);
  const pct = share === null ? null : Math.round(share * 100);
  const spent = SPEND_TOOLS.map((tool) => ({ tool, credits: facts.spend14[tool] }));
  const max = Math.max(0, ...spent.map((s) => s.credits));
  const total = facts.daily.reduce((a, d) => a + d.credits, 0);
  const peak = facts.daily.reduce<DayPoint | null>((a, d) => (a === null || d.credits > a.credits ? d : a), null);
  const exempt = facts.spendable === "exempt";
  return (
    <Card title={tc.title} right={<Fetched iso={facts.generatedAt} now={now} />}>
      {facts.spendable === "exempt" ? (
        <Note>{tc.exempt}</Note>
      ) : (
        <>
          <Figure
            label={tc.balance}
            value={facts.spendable === null ? <Missing>{td.unknown}</Missing> : n(facts.spendable)}
            sub={
              facts.renewsAt
                ? fmt(tc.renews, { date: date(facts.renewsAt) })
                : facts.endsAt
                  ? fmt(tc.ends, { date: date(facts.endsAt) })
                  : undefined
            }
          />
          {warnUsed(facts.plan) && pct !== null ? (
            <div className="flex flex-col items-start gap-2">
              <Note tone="warn">{fmt(tc.warn, { pct })}</Note>
              <Link href={path("/credits")} className="btn-quiet min-h-11 text-sm no-underline">
                {tc.buy}
              </Link>
            </div>
          ) : pct !== null ? (
            <p className="m-0 text-xs text-[var(--color-muted)]">{fmt(tc.used, { pct })}</p>
          ) : null}
          <div className="flex flex-col gap-1.5 rounded-[var(--ns-r-key)] border border-[var(--color-border)] p-3" data-forecast={f.state}>
            <span className="self-start rounded-full bg-[var(--color-panel-2)] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              {td.estimate}
            </span>
            {f.state === "estimate" ? (
              <>
                <p className="m-0 text-sm font-semibold">{fmt(tc.lastsUntil, { date: date(f.runsOutOn) })}</p>
                <p className="m-0 text-xs text-[var(--color-muted)]">{fmt(tc.perDay, { n: n(f.avgPerDay, 0) })}</p>
                {facts.renewsAt ? (
                  <p className="m-0 text-xs text-[var(--color-muted)]">{fmt(tc.beforeRenewal, { date: date(facts.renewsAt) })}</p>
                ) : null}
              </>
            ) : f.state === "past_renewal" ? (
              <>
                <p className="m-0 text-sm font-semibold">{fmt(tc.pastRenewal, { date: date(f.renewsAt) })}</p>
                <p className="m-0 text-xs text-[var(--color-muted)]">{fmt(tc.perDay, { n: n(f.avgPerDay, 0) })}</p>
              </>
            ) : (
              <p className="m-0 text-sm text-[var(--color-muted)]">{f.state === "no_spend" ? tc.noSpend : tc.noForecast}</p>
            )}
            <p className="m-0 text-xs text-[var(--color-muted)]">{tc.scheduledNote}</p>
          </div>
        </>
      )}
      {facts.daily.length >= 2 ? (
        <figure className="m-0 flex flex-col gap-1">
          <figcaption className="t-label">{tc.trend}</figcaption>
          <Spark daily={facts.daily} label={tc.trend} />
          <p className="sr-only">
            {peak ? fmt(tc.trendSummary, { max: n(peak.credits), day: date(peak.day), total: n(total) }) : null}
          </p>
        </figure>
      ) : null}
      <div className="flex flex-col gap-2">
        <div className="t-label">{exempt ? tc.usedByTool : tc.byTool}</div>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {spent.map(({ tool, credits }) => (
            <li key={tool} className="flex min-w-0 flex-col gap-1" data-tool={tool}>
              <div className="flex min-w-0 flex-wrap justify-between gap-x-3 text-sm">
                <span className="min-w-0">{tc.tools[tool]}</span>
                <span className="tabular-nums text-[var(--color-muted)]">
                  {tool === "chat" && credits === 0 ? tc.chatFree : n(credits)}
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-[var(--color-panel-2)]" aria-hidden>
                <div className="h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${max > 0 ? (credits / max) * 100 : 0}%`, opacity: 0.7 }} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function ProjectsCard({ facts }: { facts: BrainFacts }) {
  const { t, locale } = useI18n();
  const td = t.brainDash;
  const tp = td.projects;
  const path = useChannelPath();
  const { n } = useFormat(locale);
  return (
    <Card title={tp.title} right={facts.videosTotal !== null ? <span className="text-xs text-[var(--color-muted)]">{tp.videos}: {n(facts.videosTotal)}</span> : null}>
      {facts.recentVideos.length === 0 ? (
        <StateBlock
          compact
          actions={
            <Link href={path("/create")} className="btn-quiet min-h-11 text-sm no-underline">
              {tp.create}
            </Link>
          }
        >
          {tp.empty}
        </StateBlock>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-[var(--color-border)] p-0">
          {facts.recentVideos.map((v) => (
            <li key={v.videoId} className="min-w-0">
              {/* The whole row is the link (one tab stop, a 44 px target), so no row needs a repeated "Open". */}
              <Link
                href={v.channelId ? `/${encodeURIComponent(v.channelId)}/videos/${encodeURIComponent(v.videoId)}` : path(`/videos/${encodeURIComponent(v.videoId)}`)}
                className="flex min-h-11 min-w-0 items-center justify-between gap-3 py-2 text-sm text-inherit no-underline hover:underline"
              >
                <span className="min-w-0 truncate" title={v.title ?? v.videoId}>{v.title ?? v.videoId}</span>
                <span className="shrink-0 tabular-nums text-xs text-[var(--color-muted)]">
                  {v.views === null ? tp.noStats : viewsText(tp.views, v.views, locale)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function MemoryCard({ facts }: { facts: BrainFacts }) {
  const { t, locale } = useI18n();
  const td = t.brainDash;
  const tm = td.memory;
  const path = useChannelPath();
  const { n } = useFormat(locale);
  const rows: { label: string; count: number | null }[] = [
    { label: tm.characters, count: facts.memory.characters },
    { label: tm.styleKits, count: facts.memory.styleKits },
    { label: tm.brand, count: facts.memory.brandDomains },
  ];
  const nothing = rows.every((r) => r.count === 0);
  // Characters and styles are edited on Brand look; brand websites have no page of their own here, so no link claims one.
  const look = (label: string) => (
    <Link href={path("/studio/look")} className="btn-quiet min-h-11 self-start text-sm no-underline">
      {label}
    </Link>
  );
  return (
    <Card title={tm.title}>
      <p className="m-0 text-xs text-[var(--color-muted)]">{tm.subtitle}</p>
      {nothing ? (
        <StateBlock compact actions={look(tm.save)}>{tm.empty}</StateBlock>
      ) : (
        <>
          <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-3">
            {rows.map((r) => (
              <li key={r.label} className="min-w-0">
                <Figure label={r.label} value={r.count === null ? <Missing>{td.unknown}</Missing> : n(r.count)} />
              </li>
            ))}
          </ul>
          {look(tm.manage)}
        </>
      )}
    </Card>
  );
}

/**
 * The Nightshift Brain dashboard. It only reads: the facts the server read
 * as the person (brain_org_facts, 0202) and the channel's research reading.
 * "Try again" re-reads the page; nothing here renders, charges or publishes.
 */
export function BrainDashboard({
  read,
  channel,
  renderedAt,
  canRefresh,
}: {
  read: BrainFactsRead;
  channel: ChannelRead;
  /** When the server read this, so the clock starts where the server's HTML did. */
  renderedAt: string;
  /** Editor or above in the open workspace: presentation only, the refresh route and S10's function check again. */
  canRefresh: boolean;
}) {
  const { t } = useI18n();
  const td = t.brainDash;
  const path = useChannelPath();
  const now = useNow(renderedAt);
  // The channel's numbers come from their own reader, so a failed or missing facts read never hides them.
  const factsState =
    read.state === "ok" ? null : (
      <section className="panel min-w-0 p-4 sm:p-5" aria-label={t.brainDash.credits.title} data-brain-state={read.state}>
        {read.state === "failed" ? (
          <StateBlock tone="fail" role="alert" actions={<RetryKey />}>{td.readFailed}</StateBlock>
        ) : read.state === "not_found" ? (
          <StateBlock
            tone="warn"
            actions={
              <Link href={path("/organization")} className="btn-quiet min-h-11 text-sm no-underline">
                {td.switchWorkspace}
              </Link>
            }
          >
            {td.notMember}
          </StateBlock>
        ) : (
          <StateBlock
            actions={
              <Link href={path("/home")} className="btn-quiet min-h-11 text-sm no-underline">
                {td.goHome}
              </Link>
            }
          >
            {td.notAvailable}
          </StateBlock>
        )}
      </section>
    );
  const facts = read.state === "ok" ? read.facts : null;
  return (
    <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-2" data-brain-state={read.state}>
      <ChannelCard read={channel} now={now} canRefresh={canRefresh} />
      {facts ? (
        <>
          <CreditsCard facts={facts} now={now} />
          <ProjectsCard facts={facts} />
          <MemoryCard facts={facts} />
        </>
      ) : (
        factsState
      )}
      <section className="panel flex min-w-0 flex-col gap-2 p-4 sm:p-5 lg:col-span-2" aria-label={td.retention.title}>
        <header className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 text-[15px] font-semibold">{td.retention.title}</h2>
        </header>
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm text-[var(--color-muted)]">
          <li>{td.retention.published}</li>
          <li>{td.retention.unpublished}</li>
          <li>{td.retention.memory}</li>
        </ul>
      </section>
    </div>
  );
}
