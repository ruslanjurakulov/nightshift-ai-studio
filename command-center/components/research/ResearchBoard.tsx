"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { relativeTime, parseStoredTime } from "@/lib/format";
import { formatNumber } from "@/lib/number-format";
import { formatDay } from "@/lib/date-format";
import { channelPath } from "@/lib/channels";
import { pluralText } from "@/lib/plural";
import {
  lastFailed,
  type ChannelStats,
  type CommentSample,
  type CompetitorsData,
  type OwnData,
  type Panel,
  type ResearchKind,
  type ThemesData,
  type TopicData,
  type VideoStats,
} from "@/lib/research";
import type { Dictionary } from "@/lib/i18n";

type R = Dictionary["research"];

export interface ResearchBoardProps {
  /** The channel's id (what the writers take) and its URL slug (for links). */
  channel: string;
  slug: string;
  /** Editor or above: presentation only, the database decides again. */
  canEdit: boolean;
  own: Panel<OwnData>;
  competitors: Panel<CompetitorsData>;
  topic: Panel<TopicData>;
  themes: Panel<ThemesData>;
  /** The topic in the URL (?topic=), as typed. */
  topicQuery: string | null;
  /** The server's clock, so "fetched 3 min ago" reads the same on the server and in the browser. */
  nowMs: number;
}

type Answer = { ok: boolean; status: number; body: Record<string, unknown> };

async function call(url: string, method: string, body?: Record<string, unknown>): Promise<Answer> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, body: json };
  } catch {
    return { ok: false, status: 0, body: { error: "network" } };
  }
}

function errorText(r: R, a: Answer, max = 20): string {
  const word = a.status === 401 ? "unauthorized" : typeof a.body.error === "string" ? a.body.error : "failed";
  const known = r.errors as Record<string, string>;
  return fmt(known[word] ?? r.errors.failed, { max });
}

/**
 * Channel research (migration 0202): four panels, each with its own loading, empty, not-connected, refreshing, budget, error and
 * not-enabled state. Every number is YouTube's own (or Nightshift's own count of the channel's comments, labelled so); nothing on
 * this screen is computed from two numbers. Viewers' words are drawn as text nodes only. The buttons write a row through a route and
 * stop: the worker makes the YouTube calls, so a press shows "asked", never a result it did not get.
 */
export function ResearchBoard(props: ResearchBoardProps) {
  const { t, locale } = useI18n();
  const r = t.research;
  const router = useRouter();
  const [, startTransition] = useTransition();
  // A pending competitor is only being checked while a request is open; one that nobody asked about yet (after the 30-day reset,
  // say) is not polled for.
  const refreshing = [props.own, props.competitors, props.topic].some((p) => p.status === "refreshing")
    || (asked(props.competitors) && (props.competitors.data?.competitors ?? []).some((c) => c.status === "pending"));

  const [gaveUp, setGaveUp] = useState(false);

  // While the worker is fetching, look again every few seconds, and stop after a few minutes (a request the worker never picks up
  // is still shown as "refreshing" by the database; the page does not poll forever for it, and says so when it stops).
  useEffect(() => {
    if (!refreshing) return;
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      if (n > 40) {
        clearInterval(id);
        setGaveUp(true);
        return;
      }
      if (document.visibilityState === "visible") startTransition(() => router.refresh());
    }, 8000);
    return () => clearInterval(id);
  }, [refreshing, router]);

  const ctx: Ctx = { r, locale, nowMs: props.nowMs, channel: props.channel, slug: props.slug, canEdit: props.canEdit };
  const panels = [props.own, props.competitors, props.topic, props.themes];
  // 0202 not applied here: one note for the page, not four identical panels.
  if (panels.every((p) => p.status === "not_enabled")) {
    return (
      <div className="flex flex-col gap-6" data-testid="research-board">
        <p className="g3-note" role="status">{r.notEnabled}</p>
        <Attribution r={r} />
      </div>
    );
  }
  const anyError = panels.some((p) => p.status === "error");
  return (
    <div className="flex flex-col gap-6" data-testid="research-board">
      {/* One alert for the page; each panel then says quietly what it could not read. */}
      {anyError && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-[var(--color-fail)]">
          <span>{r.pageError}</span>
          <button type="button" className="btn-sky pill min-h-[44px] px-4 py-2 text-sm" onClick={() => startTransition(() => router.refresh())}>
            {r.tryAgain}
          </button>
        </div>
      )}
      {refreshing && gaveUp && <p role="status" className="g3-note">{r.stillWaiting}</p>}
      {!props.canEdit && <p className="g3-note">{r.viewerOnly}</p>}
      <OwnPanel ctx={ctx} panel={props.own} />
      <CompetitorsPanel ctx={ctx} panel={props.competitors} />
      <TopicPanel ctx={ctx} panel={props.topic} topicQuery={props.topicQuery} />
      <ThemesPanel ctx={ctx} panel={props.themes} />
      <Attribution r={r} />
    </div>
  );
}

/** Is a request open for this panel (asked, not yet answered)? */
function asked(panel: Panel<unknown>): boolean {
  const s = panel.lastRequest?.status;
  return s === "queued" || s === "running";
}

interface Ctx {
  r: R;
  locale: string;
  nowMs: number;
  channel: string;
  slug: string;
  canEdit: boolean;
}

function ago(ctx: Ctx, iso: string | null): string {
  return relativeTime(iso, ctx.locale, ctx.nowMs);
}

/** A count exactly as reported, grouped; "hidden" or "not reported" when there is none. Never a 0 for "unknown". */
function Count({ ctx, value, hidden = false }: { ctx: Ctx; value: number | null; hidden?: boolean }) {
  if (hidden) return <span className="text-[var(--color-muted)]">{ctx.r.hidden}</span>;
  if (value === null) return <span className="text-[var(--color-muted)]">{ctx.r.notReported}</span>;
  return <span className="tabular-nums">{formatNumber(value, ctx.locale, 0)}</span>;
}

function Card({ title, actions, children, source, testid }: { title: string; actions?: ReactNode; children: ReactNode; source: ReactNode; testid: string }) {
  return (
    <section className="section-card flex min-w-0 flex-col gap-3" aria-label={title} data-testid={testid}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="t-panel m-0">{title}</h2>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children}
      <p className="m-0 text-xs text-[var(--color-muted)]">{source}</p>
    </section>
  );
}

/** What a panel says when it has no numbers to show: the database's status, in words, with the fix when there is one. */
function StatusNote({ ctx, panel, empty }: { ctx: Ctx; panel: Panel<unknown>; empty?: string }) {
  const { r } = ctx;
  const remedy = panel.remedyCode ? r.remedy[panel.remedyCode] : null;
  if (panel.status === "refreshing") return <p role="status" className="m-0 text-sm">{r.refreshing}</p>;
  if (panel.status === "not_enabled") return <p className="m-0 text-sm">{r.status.not_enabled}</p>;
  if (panel.status === "error") return <p className="m-0 text-sm text-[var(--color-fail)]">{r.status.error}</p>;
  if (panel.status === "not_connected") {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p className="m-0">{r.status.not_connected}</p>
        <p className="m-0 text-[var(--color-muted)]">{remedy ?? r.remedy.connect}</p>
        <Link href={channelPath(ctx.slug, "/channels")} className="btn-sky pill min-h-[44px] self-start px-4 py-2 text-sm">
          {r.connectCta}
        </Link>
      </div>
    );
  }
  if (panel.status === "budget_exhausted") {
    return (
      <div className="flex flex-col gap-1 text-sm">
        <p className="m-0">{r.status.budget_exhausted}</p>
        <p className="m-0 text-[var(--color-muted)]">{remedy ?? r.remedy.budget}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="m-0">{empty ?? r.status.no_data}</p>
      {remedy && <p className="m-0 text-[var(--color-muted)]">{remedy}</p>}
    </div>
  );
}

/** "The last refresh did not finish: <fix>" next to numbers that are older than the person may think. */
function LastFailed({ ctx, panel }: { ctx: Ctx; panel: Panel<unknown> }) {
  if (panel.status !== "ok" || !lastFailed(panel)) return null;
  const remedy = panel.remedyCode ? ctx.r.remedy[panel.remedyCode] : ctx.r.remedy.retry;
  return (
    <p role="status" className="m-0 text-sm text-[var(--color-warn)]">
      {ctx.r.lastFailed} {remedy}
    </p>
  );
}

function Fetched({ ctx, at }: { ctx: Ctx; at: string | null }) {
  if (!at) return null;
  return <span className="text-xs text-[var(--color-muted)]">{fmt(ctx.r.fetched, { ago: ago(ctx, at) })}</span>;
}

function RefreshButton({ ctx, kind, panelTitle, disabled }: { ctx: Ctx; kind: ResearchKind; panelTitle: string; disabled?: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "fail"; text: string } | null>(null);
  const press = async () => {
    setBusy(true);
    setMessage(null);
    const a = await call("/api/research/refresh", "POST", { channel: ctx.channel, kind });
    setBusy(false);
    if (!a.ok) return setMessage({ tone: "fail", text: errorText(ctx.r, a) });
    if (a.body.status === "recent") {
      setMessage({ tone: "ok", text: fmt(ctx.r.recent, { ago: ago(ctx, typeof a.body.fetched_at === "string" ? a.body.fetched_at : null) }) });
    } else {
      setMessage({ tone: "ok", text: ctx.r.queued });
    }
    startTransition(() => router.refresh());
  };
  const off = disabled || !ctx.canEdit || busy;
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className={`btn-sky pill min-h-[44px] px-4 py-2 text-sm ${DISABLED}`}
        disabled={off}
        aria-busy={busy || undefined}
        aria-label={fmt(ctx.r.refreshAria, { panel: panelTitle })}
        title={!ctx.canEdit ? ctx.r.viewerOnly : undefined}
        onClick={() => void press()}
      >
        {busy ? ctx.r.refreshPending : ctx.r.refresh}
      </button>
      {message && (
        <p role="status" className={`m-0 max-w-[18rem] text-right text-xs ${message.tone === "ok" ? "text-[var(--color-muted)]" : "text-[var(--color-fail)]"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}

/** A disabled control must look disabled, not merely refuse the press. */
const DISABLED = "disabled:cursor-not-allowed disabled:opacity-50";

function StatGrid({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="m-0 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <dt className="text-xs text-[var(--color-muted)]">{it.label}</dt>
          <dd className="m-0 text-lg font-semibold">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ChannelStatsGrid({ ctx, c }: { ctx: Ctx; c: ChannelStats }) {
  return (
    <StatGrid
      items={[
        { label: ctx.r.own.subscribers, value: <Count ctx={ctx} value={c.subscriberCount} hidden={c.subscribersHidden} /> },
        { label: ctx.r.own.views, value: <Count ctx={ctx} value={c.viewCount} /> },
        { label: ctx.r.own.videos, value: <Count ctx={ctx} value={c.videoCount} /> },
      ]}
    />
  );
}

function VideoList({ ctx, videos, own = false }: { ctx: Ctx; videos: VideoStats[]; own?: boolean }) {
  const { r } = ctx;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {videos.map((v) => {
        const day = parseStoredTime(v.publishedAt);
        return (
          <li key={v.videoId} className="min-w-0 border-t border-[var(--color-border)] pt-2">
            <a
              href={`https://www.youtube.com/watch?v=${encodeURIComponent(v.videoId)}`}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="block break-words text-sm font-medium"
              dir="auto"
            >
              {v.title ?? v.videoId}
            </a>
            <dl className="m-0 mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
              <div className="flex gap-1"><dt>{r.video.published}</dt><dd className="m-0">{day ? formatDay(day, ctx.locale, "UTC") : r.notReported}</dd></div>
              <div className="flex gap-1"><dt>{r.video.views}</dt><dd className="m-0"><Count ctx={ctx} value={v.viewCount} /></dd></div>
              <div className="flex gap-1"><dt>{r.video.likes}</dt><dd className="m-0"><Count ctx={ctx} value={v.likeCount} /></dd></div>
              <div className="flex gap-1"><dt>{r.video.comments}</dt><dd className="m-0"><Count ctx={ctx} value={v.commentCount} /></dd></div>
              {own && <div><dd className="m-0" data-testid="research-privacy">{r.own.privacy[v.privacyStatus ?? "unknown"]}</dd></div>}
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

function OwnPanel({ ctx, panel }: { ctx: Ctx; panel: Panel<OwnData> }) {
  const { r } = ctx;
  const d = panel.data;
  const enabled = panel.status !== "not_enabled" && panel.status !== "error";
  return (
    <Card
      testid="research-own"
      title={r.own.title}
      source={r.sourceYoutube}
      actions={
        <>
          <Fetched ctx={ctx} at={panel.fetchedAt} />
          {enabled && <RefreshButton ctx={ctx} kind="own_channel" panelTitle={r.own.title} disabled={panel.status === "not_connected" || panel.status === "refreshing"} />}
        </>
      }
    >
      <LastFailed ctx={ctx} panel={panel} />
      {d && d.channel ? <ChannelStatsGrid ctx={ctx} c={d.channel} /> : null}
      {d && d.analytics ? (
        <div className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold">{fmt(r.own.analyticsTitle, { n: d.analytics.periodDays })}</h3>
          <StatGrid
            items={[
              { label: r.own.aViews, value: <Count ctx={ctx} value={d.analytics.views} /> },
              { label: r.own.minutes, value: <Count ctx={ctx} value={d.analytics.minutesWatched} /> },
              { label: r.own.gained, value: <Count ctx={ctx} value={d.analytics.subscribersGained} /> },
              { label: r.own.lost, value: <Count ctx={ctx} value={d.analytics.subscribersLost} /> },
            ]}
          />
        </div>
      ) : null}
      {d && d.recentVideos.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="m-0 text-sm font-semibold">{r.own.latest}</h3>
          <p className="m-0 text-xs text-[var(--color-muted)]">{r.own.latestHint}</p>
          <VideoList ctx={ctx} videos={d.recentVideos} own />
        </div>
      ) : null}
      {(!d || panel.status !== "ok") && <StatusNote ctx={ctx} panel={panel} />}
    </Card>
  );
}

function AddCompetitorForm({ ctx, full, max }: { ctx: Ctx; full: boolean; max: number }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "fail"; text: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ref.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    const a = await call("/api/research/competitors", "POST", { channel: ctx.channel, ref: ref.trim() });
    setBusy(false);
    if (!a.ok) return setMessage({ tone: "fail", text: errorText(ctx.r, a, max) });
    setMessage({ tone: "ok", text: a.body.already ? ctx.r.competitors.already : ctx.r.competitors.added });
    setRef("");
    startTransition(() => router.refresh());
  };
  const id = "research-competitor-ref";
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium">{ctx.r.competitors.label}</label>
      <div className="flex flex-wrap gap-2">
        <input
          id={id}
          className="ns-field min-h-[44px] min-w-0 flex-1 basis-56"
          value={ref}
          maxLength={300}
          autoComplete="off"
          spellCheck={false}
          placeholder={ctx.r.competitors.placeholder}
          disabled={!ctx.canEdit || full}
          aria-invalid={message?.tone === "fail" || undefined}
          aria-describedby={message ? `${id}-msg` : undefined}
          onChange={(e) => setRef(e.target.value)}
        />
        <button type="submit" className={`btn-sky is-solid pill min-h-[44px] px-5 py-2 text-sm ${DISABLED}`} aria-busy={busy || undefined} disabled={!ctx.canEdit || full || busy || !ref.trim()}>
          {busy ? ctx.r.competitors.adding : ctx.r.competitors.add}
        </button>
      </div>
      {full && <p className="m-0 text-xs text-[var(--color-muted)]">{fmt(ctx.r.errors.limit_reached, { max })}</p>}
      {message && (
        <p id={`${id}-msg`} role={message.tone === "ok" ? "status" : "alert"} className={`m-0 text-sm ${message.tone === "ok" ? "text-[var(--color-muted)]" : "text-[var(--color-fail)]"}`}>{message.text}</p>
      )}
    </form>
  );
}

function RemoveButton({ ctx, id, name }: { ctx: Ctx; id: string; name: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const press = async () => {
    setBusy(true);
    setFailed(null);
    const a = await call(`/api/research/competitors/${encodeURIComponent(id)}?channel=${encodeURIComponent(ctx.channel)}`, "DELETE");
    setBusy(false);
    if (!a.ok) return setFailed(errorText(ctx.r, a));
    startTransition(() => router.refresh());
  };
  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        className={`btn-sky ghost pill min-h-[44px] px-4 py-2 text-sm ${DISABLED}`}
        disabled={!ctx.canEdit || busy}
        aria-busy={busy || undefined}
        aria-label={fmt(ctx.r.competitors.removeAria, { name })}
        onClick={() => void press()}
      >
        {ctx.r.competitors.remove}
      </button>
      {failed && <span role="alert" className="text-xs text-[var(--color-fail)]">{failed}</span>}
    </span>
  );
}

function CompetitorsPanel({ ctx, panel }: { ctx: Ctx; panel: Panel<CompetitorsData> }) {
  const { r } = ctx;
  const list = panel.data?.competitors ?? [];
  const max = panel.data?.max ?? 20;
  const enabled = panel.status !== "not_enabled" && panel.status !== "error";
  return (
    <Card
      testid="research-competitors"
      title={r.competitors.title}
      source={r.sourceYoutube}
      actions={
        <>
          <Fetched ctx={ctx} at={panel.fetchedAt} />
          {enabled && list.length > 0 && <RefreshButton ctx={ctx} kind="competitors" panelTitle={r.competitors.title} disabled={panel.status === "refreshing" || panel.status === "not_connected"} />}
        </>
      }
    >
      <p className="m-0 text-sm text-[var(--color-muted)]">
        {fmt(r.competitors.hint, { max })} {enabled && <span className="tabular-nums">{fmt(r.competitors.count, { n: list.length, max })}</span>}
      </p>
      <LastFailed ctx={ctx} panel={panel} />
      {list.length > 0 && panel.status !== "ok" && <StatusNote ctx={ctx} panel={panel} />}
      {enabled && panel.status !== "not_connected" && <AddCompetitorForm ctx={ctx} full={list.length >= max} max={max} />}
      {list.length > 0 && <p className="m-0 text-xs text-[var(--color-muted)]">{r.competitors.publicOnly}</p>}
      {list.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {list.map((c) => {
            const name = c.channel?.title ?? c.inputRef;
            return (
              <li key={c.id} className="flex min-w-0 flex-col gap-2 border-t border-[var(--color-border)] pt-3" data-testid="research-competitor">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="m-0 break-words font-semibold" dir="auto">{name}</p>
                    {c.channel && <p className="m-0 break-all text-xs text-[var(--color-muted)]">{c.channel.handle ?? c.inputRef}</p>}
                  </div>
                  <RemoveButton ctx={ctx} id={c.id} name={name} />
                </div>
                {c.status === "pending" && c.lastError === "lookup_failed" && (
                  <p className="m-0 text-sm text-[var(--color-warn)]">{r.competitors.lookupFailed}</p>
                )}
                {c.status === "invalid_ref" && <p className="m-0 text-sm text-[var(--color-warn)]">{r.competitors.invalidRef}</p>}
                {c.status === "pending" && !c.lastError && (asked(panel)
                  ? <p role="status" className="m-0 text-sm">{r.competitors.pending}</p>
                  : <p className="m-0 text-sm text-[var(--color-muted)]">{r.competitors.notAsked}</p>)}
                {c.status === "not_found" && <p className="m-0 text-sm text-[var(--color-warn)]">{r.competitors.notFound}</p>}
                {c.status === "own_channel" && <p className="m-0 text-sm text-[var(--color-warn)]">{r.competitors.ownChannel}</p>}
                {c.status === "resolved" && (c.channel ? (
                  <>
                    <ChannelStatsGrid ctx={ctx} c={c.channel} />
                    <Fetched ctx={ctx} at={c.channel.fetchedAt} />
                    {c.videos.length > 0 ? <VideoList ctx={ctx} videos={c.videos} /> : <p className="m-0 text-sm text-[var(--color-muted)]">{r.competitors.noVideos}</p>}
                  </>
                ) : (
                  <p className="m-0 text-sm text-[var(--color-muted)]">{r.competitors.statsMissing}</p>
                ))}
              </li>
            );
          })}
        </ul>
      ) : (
        <StatusNote ctx={ctx} panel={panel} empty={r.competitors.empty} />
      )}
    </Card>
  );
}

function TopicPanel({ ctx, panel, topicQuery }: { ctx: Ctx; panel: Panel<TopicData>; topicQuery: string | null }) {
  const { r } = ctx;
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [value, setValue] = useState(topicQuery ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "fail"; text: string } | null>(null);
  const enabled = panel.status !== "not_enabled" && panel.status !== "error";
  const d = panel.data;
  const go = (topic: string) => {
    const q = new URLSearchParams({ topic });
    startTransition(() => router.push(`${channelPath(ctx.slug, "/research")}?${q.toString()}`, { scroll: false }));
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const topic = value.trim();
    if (topic.length < 2 || busy) return;
    setBusy(true);
    setMessage(null);
    const a = await call("/api/research/refresh", "POST", { channel: ctx.channel, kind: "topic", topic });
    setBusy(false);
    if (!a.ok) {
      setMessage({ tone: "fail", text: errorText(ctx.r, a) });
      // Results that already exist for this topic are still worth showing.
      if (a.status !== 400) go(topic);
      return;
    }
    setMessage({ tone: "ok", text: a.body.status === "recent"
      ? fmt(r.recent, { ago: ago(ctx, typeof a.body.fetched_at === "string" ? a.body.fetched_at : null) })
      : r.queued });
    go(topic);
  };
  const id = "research-topic";
  return (
    <Card testid="research-topic" title={r.topic.title} source={r.sourceYoutube} actions={<Fetched ctx={ctx} at={panel.fetchedAt} />}>
      <p className="m-0 text-sm text-[var(--color-muted)]">{r.topic.hint}</p>
      {enabled && panel.status !== "not_connected" && (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
          <label htmlFor={id} className="text-sm font-medium">{r.topic.label}</label>
          <div className="flex flex-wrap gap-2">
            <input
              id={id}
              className="ns-field min-h-[44px] min-w-0 flex-1 basis-56"
              value={value}
              maxLength={80}
              placeholder={r.topic.placeholder}
              disabled={!ctx.canEdit}
              onChange={(e) => setValue(e.target.value)}
            />
            <button type="submit" className={`btn-sky is-solid pill min-h-[44px] px-5 py-2 text-sm ${DISABLED}`} aria-busy={busy || undefined} disabled={!ctx.canEdit || busy || value.trim().length < 2}>
              {busy ? r.topic.searching : r.topic.search}
            </button>
          </div>
          {message && (
            <p role={message.tone === "ok" ? "status" : "alert"} className={`m-0 text-sm ${message.tone === "ok" ? "text-[var(--color-muted)]" : "text-[var(--color-fail)]"}`}>{message.text}</p>
          )}
        </form>
      )}
      {d && d.recentTopics.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-[var(--color-muted)]">{r.topic.recentLabel}</span>
          {d.recentTopics.map((x) => (
            <Link key={x.topic} href={`${channelPath(ctx.slug, "/research")}?${new URLSearchParams({ topic: x.topic }).toString()}`} className="btn-sky ghost pill inline-flex min-h-[44px] items-center px-3 py-1 text-sm" dir="auto" scroll={false}>
              {x.topic}
            </Link>
          ))}
        </div>
      )}
      <LastFailed ctx={ctx} panel={panel} />
      {d && d.topic && panel.status === "ok" ? (
        <div className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold" dir="auto">{fmt(r.topic.resultsFor, { topic: d.topic })}</h3>
          {d.channels.length > 0 ? (
            <ol className="m-0 flex list-decimal flex-col gap-3 pl-5">
              {d.channels.map((c) => (
                <li key={c.youtubeChannelId} className="min-w-0">
                  <a
                    href={`https://www.youtube.com/channel/${encodeURIComponent(c.youtubeChannelId)}`}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="break-words font-medium"
                    dir="auto"
                  >
                    {c.title ?? c.youtubeChannelId}
                  </a>
                  <div className="mt-1"><ChannelStatsGrid ctx={ctx} c={c} /></div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="m-0 text-sm">{r.topic.noResults}</p>
          )}
        </div>
      ) : topicQuery || panel.status !== "ok" ? (
        <StatusNote ctx={ctx} panel={panel} empty={topicQuery ? r.topic.noDataYet : r.topic.empty} />
      ) : (
        <p className="m-0 text-sm text-[var(--color-muted)]">{r.topic.empty}</p>
      )}
    </Card>
  );
}

function Samples({ samples }: { samples: CommentSample[] }) {
  if (samples.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {samples.map((s, i) => (
        // A viewer's words: a text node, wrapped, in its own direction. Never a link, never markup.
        <li key={`${s.videoId ?? ""}-${i}`} className="break-words border-l-2 border-[var(--color-border)] pl-2 text-sm" dir="auto">
          {s.untrustedText}
        </li>
      ))}
    </ul>
  );
}

/** One of Nightshift's own counts in a sentence ("12 comments read"), plural-aware; "not reported" when the answer had none. */
function NightshiftCount({ ctx, forms, value }: { ctx: Ctx; forms: R["themes"]["total"]; value: number | null }) {
  if (value === null) return <span className="text-[var(--color-muted)]">{ctx.r.notReported}</span>;
  return <>{pluralText(forms, value, ctx.locale).replace(String(value), formatNumber(value, ctx.locale, 0))}</>;
}

function ThemesPanel({ ctx, panel }: { ctx: Ctx; panel: Panel<ThemesData> }) {
  const { r } = ctx;
  const d = panel.data;
  const days = d?.periodDays ?? 28;
  return (
    <Card
      testid="research-themes"
      title={r.themes.title}
      source={r.sourceNightshift}
      actions={<Fetched ctx={ctx} at={panel.fetchedAt} />}
    >
      <p className="m-0 text-sm text-[var(--color-muted)]">{fmt(r.themes.hint, { n: days })}</p>
      {d && panel.status === "ok" ? (
        <>
          <p className="m-0 text-sm tabular-nums"><NightshiftCount ctx={ctx} forms={r.themes.total} value={d.totalComments} /></p>
          <div className="flex flex-col gap-2">
            <h3 className="m-0 text-sm font-semibold">{r.themes.questions}</h3>
            <p className="m-0 text-sm text-[var(--color-muted)]"><NightshiftCount ctx={ctx} forms={r.themes.questionsCount} value={d.questions.count} /></p>
            <Samples samples={d.questions.samples} />
          </div>
          {d.words.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="m-0 text-sm font-semibold">{r.themes.words}</h3>
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {d.words.map((w) => (
                  <li key={w.untrustedWord} className="flex flex-col gap-1">
                    <p className="m-0 text-sm">
                      <span className="font-semibold" dir="auto">{w.untrustedWord}</span>{" "}
                      <span className="text-[var(--color-muted)]"><NightshiftCount ctx={ctx} forms={r.themes.mentions} value={w.count} /></span>
                    </p>
                    <Samples samples={w.samples} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <StatusNote ctx={ctx} panel={panel} empty={fmt(r.themes.empty, { n: days })} />
      )}
      <Link href={channelPath(ctx.slug, "/inbox")} className="self-start text-sm underline">{r.themes.inbox}</Link>
    </Card>
  );
}

/** YouTube's attribution: the source next to the data, a plain text link to YouTube (no logo) and to its Terms of Service. */
function Attribution({ r }: { r: R }) {
  return (
    <footer className="flex flex-col gap-1 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-muted)]" data-testid="research-attribution">
      <p className="m-0">
        {r.attribution.lead}{" "}
        <a href="https://www.youtube.com" target="_blank" rel="noopener noreferrer" className="underline">{r.attribution.site}</a>
        {" · "}
        <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer" className="underline">{r.attribution.terms}</a>
      </p>
      <p className="m-0">{r.attribution.note}</p>
    </footer>
  );
}
