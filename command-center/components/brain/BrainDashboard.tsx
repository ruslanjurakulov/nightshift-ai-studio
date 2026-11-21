"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Clock3, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
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

function useFormat(locale: string) {
  const n = (v: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(v);
  const date = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? iso : new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(t);
  };
  return { n, date };
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
function RefreshKey({ channelId }: { channelId: string }) {
  const { t } = useI18n();
  const tc = t.brainDash.channel;
  const router = useRouter();
  const busy = useRef(false);
  const [state, setState] = useState<"idle" | "busy" | "asked" | "recent" | "limit" | "forbidden" | "failed">("idle");
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
      const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
      setState(
        res.ok
          ? body.status === "recent" ? "recent" : "asked"
          : body.error === "daily_limit" ? "limit" : body.error === "forbidden" ? "forbidden" : "failed",
      );
      if (res.ok) router.refresh();
    } catch {
      setState("failed");
    } finally {
      busy.current = false;
    }
  }
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <button type="button" className="btn-quiet min-h-11 text-sm" onClick={() => void ask()} aria-busy={state === "busy"} data-refresh={state}>
        <RefreshCw aria-hidden className={`size-4 ${state === "busy" ? "motion-safe:animate-spin" : ""}`} />
        {tc.refresh}
      </button>
      <span role="status" aria-live="polite" className="text-xs text-[var(--color-muted)]">
        {state === "asked"
          ? tc.refreshAsked
          : state === "recent"
            ? tc.refreshRecent
            : state === "limit"
              ? tc.budget
              : state === "forbidden"
                ? tc.refreshForbidden
                : state === "failed"
                  ? tc.refreshFailed
                  : ""}
      </span>
    </div>
  );
}

function ChannelCard({ read, now }: { read: ChannelRead; now: number }) {
  const { t, locale } = useI18n();
  const td = t.brainDash;
  const tc = td.channel;
  const { n, date } = useFormat(locale);
  const fetchedAt = "fetchedAt" in read ? read.fetchedAt : null;
  const channelId = "channelId" in read ? read.channelId : null;
  const missing = (v: number | null) => (v === null ? td.unknown : n(v));
  return (
    <Card title={read.state === "ok" && read.title ? `${tc.title} · ${read.title}` : tc.title} right={"fetchedAt" in read ? <Fetched iso={fetchedAt} now={now} /> : null}>
      {read.state === "ok" ? (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Figure label={tc.subscribers} value={read.subscribersHidden ? td.hidden : missing(read.subscribers)} />
            <Figure label={tc.views} value={missing(read.views)} />
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
                  value={`${missing(read.analytics.subsGained)} / ${missing(read.analytics.subsLost)}`}
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
                    <span className="min-w-0 truncate">{v.title ?? v.videoId}</span>
                    <span className="shrink-0 tabular-nums text-[var(--color-muted)]">{missing(v.views)}</span>
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
                    {th.count !== null ? <span className="ml-1 tabular-nums text-[var(--color-muted)]">{n(th.count)}</span> : null}
                  </li>
                ))}
              </ul>
              <p className="m-0 text-xs text-[var(--color-muted)]">{tc.themesSource}</p>
            </div>
          ) : null}
        </>
      ) : read.state === "not_connected" ? (
        <Note>{tc.notConnected}</Note>
      ) : read.state === "budget_exhausted" ? (
        <Note tone="warn">{tc.budget}</Note>
      ) : read.state === "refreshing" ? (
        <Note>{tc.refreshing}</Note>
      ) : read.state === "no_data" ? (
        <Note>{tc.noData}</Note>
      ) : read.state === "failed" ? (
        <Note tone="fail">{td.readFailed}</Note>
      ) : read.state === "pick_channel" ? (
        <Note>{tc.pickChannel}</Note>
      ) : read.state === "no_channel" ? (
        <Note>{tc.noChannel}</Note>
      ) : (
        <Note>{tc.waiting}</Note>
      )}
      {channelId && read.state !== "not_connected" ? <RefreshKey channelId={channelId} /> : null}
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
  return (
    <Card title={tc.title} right={<Fetched iso={facts.generatedAt} now={now} />}>
      {facts.spendable === "exempt" ? (
        <Note>{tc.exempt}</Note>
      ) : (
        <>
          <Figure
            label={tc.balance}
            value={facts.spendable === null ? td.unknown : n(facts.spendable)}
            sub={
              facts.renewsAt
                ? fmt(tc.renews, { date: date(facts.renewsAt) })
                : facts.endsAt
                  ? fmt(tc.ends, { date: date(facts.endsAt) })
                  : undefined
            }
          />
          {warnUsed(facts.plan) && pct !== null ? (
            <Note tone="warn">
              {fmt(tc.warn, { pct })}{" "}
              <Link href={path("/credits")} className="underline">
                {tc.buy}
              </Link>
            </Note>
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
                <p className="m-0 text-xs text-[var(--color-muted)]">{fmt(tc.perDay, { n: n(f.avgPerDay) })}</p>
                {facts.renewsAt ? (
                  <p className="m-0 text-xs text-[var(--color-muted)]">{fmt(tc.beforeRenewal, { date: date(facts.renewsAt) })}</p>
                ) : null}
              </>
            ) : f.state === "past_renewal" ? (
              <>
                <p className="m-0 text-sm font-semibold">{fmt(tc.pastRenewal, { date: date(f.renewsAt) })}</p>
                <p className="m-0 text-xs text-[var(--color-muted)]">{fmt(tc.perDay, { n: n(f.avgPerDay) })}</p>
              </>
            ) : (
              <p className="m-0 text-sm text-[var(--color-muted)]">{f.state === "no_spend" ? tc.noSpend : tc.noForecast}</p>
            )}
            <p className="m-0 text-xs text-[var(--color-muted)]">{tc.scheduledNote}</p>
          </div>
        </>
      )}
      <Spark daily={facts.daily} label={tc.trend} />
      <div className="flex flex-col gap-2">
        <div className="t-label">{tc.byTool}</div>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {spent.map(({ tool, credits }) => (
            <li key={tool} className="flex min-w-0 flex-col gap-1" data-tool={tool}>
              <div className="flex min-w-0 justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{tc.tools[tool]}</span>
                <span className="shrink-0 tabular-nums text-[var(--color-muted)]">
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
        <Note>{tp.empty}</Note>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-[var(--color-border)] p-0">
          {facts.recentVideos.map((v) => (
            <li key={v.videoId} className="flex min-w-0 items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 truncate">{v.title ?? v.videoId}</span>
              <span className="flex shrink-0 items-center gap-3">
                <span className="tabular-nums text-xs text-[var(--color-muted)]">
                  {v.views === null ? tp.noStats : fmt(tp.views, { n: n(v.views) })}
                </span>
                <Link href={v.channelId ? `/${encodeURIComponent(v.channelId)}/videos/${encodeURIComponent(v.videoId)}` : path(`/videos/${encodeURIComponent(v.videoId)}`)} className="btn-quiet min-h-11 text-xs no-underline">
                  {tp.open}
                </Link>
              </span>
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
  const rows: { label: string; count: number | null; href: string }[] = [
    { label: tm.characters, count: facts.memory.characters, href: "/studio/look" },
    { label: tm.styleKits, count: facts.memory.styleKits, href: "/studio/look" },
    { label: tm.brand, count: facts.memory.brandDomains, href: "/studio/look" },
  ];
  const nothing = rows.every((r) => r.count === 0);
  return (
    <Card title={tm.title}>
      <p className="m-0 text-xs text-[var(--color-muted)]">{tm.subtitle}</p>
      {nothing ? (
        <Note>{tm.empty}</Note>
      ) : (
        <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-3">
          {rows.map((r) => (
            <li key={r.label} className="flex min-w-0 flex-col gap-2">
              <Figure label={r.label} value={r.count === null ? td.unknown : n(r.count)} />
              <Link href={path(r.href)} className="btn-quiet min-h-11 self-start text-xs no-underline">
                {tm.manage}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * The Nightshift Brain dashboard. It only reads: the facts the server read
 * as the person (brain_org_facts, 0201) and the channel's research reading.
 * "Try again" re-reads the page; nothing here renders, charges or publishes.
 */
export function BrainDashboard({
  read,
  channel,
  renderedAt,
}: {
  read: BrainFactsRead;
  channel: ChannelRead;
  /** When the server read this, so the clock starts where the server's HTML did. */
  renderedAt: string;
}) {
  const { t } = useI18n();
  const td = t.brainDash;
  const router = useRouter();
  const now = useNow(renderedAt);
  if (read.state !== "ok") {
    return (
      <div className="panel flex flex-col items-start gap-3 p-5" data-brain-state={read.state}>
        <Note tone={read.state === "failed" ? "fail" : "muted"}>
          {read.state === "failed" ? td.readFailed : read.state === "not_found" ? td.notMember : td.notAvailable}
        </Note>
        {read.state === "failed" ? (
          <button type="button" className="btn-quiet min-h-11 text-sm" onClick={() => router.refresh()}>
            <RefreshCw aria-hidden className="size-4" />
            {td.retry}
          </button>
        ) : null}
      </div>
    );
  }
  const facts = read.facts;
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2" data-brain-state="ok">
      <ChannelCard read={channel} now={now} />
      <CreditsCard facts={facts} now={now} />
      <ProjectsCard facts={facts} />
      <MemoryCard facts={facts} />
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
