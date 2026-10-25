"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { relativeTime } from "@/lib/format";
import { StateBlock } from "@/components/states/StateBlock";
import { topByViews, type HistoryEntry, type Kpis, type VideoResult } from "@/lib/resultsDashboard/aggregate";
import { barPercent, dayOf, formatCount, formatDuration, formatHours } from "@/lib/resultsDashboard/format";
import { knownReason, youtubeWatchUrl } from "@/lib/publish";
import type { PlatformCard } from "@/lib/resultsDashboard/platforms";
import type { ResultsPayload } from "@/lib/resultsDashboard/payload";

/**
 * The dashboard's sections. Presentational only: they draw a payload the server already assembled and never fetch, derive
 * a number the payload does not carry, or fill a gap with a default. An unknown is a word (`notMeasured`), never "0".
 */

export function Freshness({ payload }: { payload: ResultsPayload }) {
  const { t, locale, fmt } = useI18n();
  const r = t.resultsDashboard;
  const f = payload.freshness;
  return (
    <div className="rd-fresh">
      <p className="rd-fresh-line">
        {f.asOf ? (
          <strong>{fmt(r.asOf, { date: f.asOf, ago: relativeTime(f.asOf, locale) })}</strong>
        ) : (
          <strong>{r.noReadingYet}</strong>
        )}
      </p>
      <p className="rd-small">{r.source}</p>
      <p className="rd-small">{r.readingNote}</p>
      {f.stale && f.asOf && f.ageDays !== null && (
        <StateBlock tone="warn" role="status" compact title={fmt(r.staleTitle, { n: f.ageDays })}>
          {fmt(r.staleBody, { date: f.asOf })}
        </StateBlock>
      )}
    </div>
  );
}

function Figure({ label, children, sub }: { label: string; children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="rd-kpi">
      <dt className="rd-kpi-label">{label}</dt>
      <dd className="rd-kpi-value">{children}</dd>
      {sub !== undefined && <dd className="rd-kpi-sub">{sub}</dd>}
    </div>
  );
}

export function KpiRow({ kpis }: { kpis: Kpis }) {
  const { t, locale, fmt } = useI18n();
  const r = t.resultsDashboard;
  const covers = (known: number, of: number) => fmt(r.measuredOf, { known, of });
  const duration = kpis.avgViewSeconds.value === null ? null : formatDuration(kpis.avgViewSeconds.value);
  return (
    <dl className="rd-kpis" aria-label={r.kpisLabel}>
      <Figure label={r.kpi.videos}>{formatCount(kpis.videos, locale)}</Figure>
      <Figure label={r.kpi.views} sub={covers(kpis.views.known, kpis.views.of)}>
        {kpis.views.value === null ? <span className="rd-unknown">{r.notMeasured}</span> : formatCount(kpis.views.value, locale)}
      </Figure>
      <Figure label={r.kpi.watch} sub={covers(kpis.watchHours.known, kpis.watchHours.of)}>
        {kpis.watchHours.value === null ? <span className="rd-unknown">{r.notMeasured}</span> : fmt(r.hoursUnit, { n: formatHours(kpis.watchHours.value, locale) })}
      </Figure>
      <Figure label={r.kpi.duration} sub={covers(kpis.avgViewSeconds.known, kpis.avgViewSeconds.of)}>
        {duration === null ? <span className="rd-unknown">{r.notMeasured}</span> : duration}
      </Figure>
      <Figure label={r.kpi.subscribers} sub={r.subscribersNote}>
        <span className="rd-unknown">{r.notCollected}</span>
      </Figure>
    </dl>
  );
}

export function TopVideos({ videos }: { videos: readonly VideoResult[] }) {
  const { t, locale } = useI18n();
  const r = t.resultsDashboard;
  const top = topByViews(videos, 5);
  const max = top.length > 0 ? (top[0].reading!.views as number) : 0;
  return (
    <section className="rd-section" aria-labelledby="rd-top-h">
      <h2 id="rd-top-h" className="rd-h">{r.topTitle}</h2>
      {top.length === 0 ? (
        <p className="rd-small">{r.topEmpty}</p>
      ) : (
        <>
          <ol className="rd-rank">
            {top.map((v) => (
              <li key={v.videoId}>
                <span className="rd-rank-title">{v.title ?? r.untitled}</span>
                <span className="rd-rank-bar" aria-hidden>
                  <span style={{ width: `${barPercent(v.reading!.views as number, max)}%` }} />
                </span>
                <span className="rd-rank-val">{formatCount(v.reading!.views as number, locale)}</span>
              </li>
            ))}
          </ol>
          <p className="rd-small">{r.topNote}</p>
        </>
      )}
    </section>
  );
}

export type VideoSort = "views" | "newest";

export function sortVideos(videos: readonly VideoResult[], sort: VideoSort): VideoResult[] {
  const rows = [...videos];
  if (sort === "newest") return rows;
  // Unmeasured videos go last: they have no views figure to rank by, and they are not "0".
  return rows.sort((a, b) => {
    const av = a.reading?.views ?? null;
    const bv = b.reading?.views ?? null;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av;
  });
}

export function VideoTable({ videos, sort, onSort, videosHref }: { videos: readonly VideoResult[]; sort: VideoSort; onSort: (s: VideoSort) => void; videosHref: string }) {
  const { t, locale, fmt } = useI18n();
  const r = t.resultsDashboard;
  const rows = sortVideos(videos, sort);
  return (
    <section className="rd-section" aria-labelledby="rd-videos-h">
      <div className="rd-head">
        <h2 id="rd-videos-h" className="rd-h">{r.tableTitle}</h2>
        <label className="rd-field rd-field-inline">
          <span className="rd-label">{r.sortLabel}</span>
          <select className="ns-field" value={sort} onChange={(e) => onSort(e.target.value === "newest" ? "newest" : "views")}>
            <option value="views">{r.sortViews}</option>
            <option value="newest">{r.sortNewest}</option>
          </select>
        </label>
      </div>
      <table className="rd-table">
        <caption className="rd-sr">{r.tableCaption}</caption>
        <thead>
          <tr>
            <th scope="col">{r.col.video}</th>
            <th scope="col">{r.col.published}</th>
            <th scope="col" className="rd-num">{r.col.views}</th>
            <th scope="col" className="rd-num">{r.col.watch}</th>
            <th scope="col" className="rd-num">{r.col.duration}</th>
            <th scope="col">{r.col.reading}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => {
            const rd = v.reading;
            const title = v.title ?? r.untitled;
            const watchUrl = youtubeWatchUrl(v.videoId);
            const dur = rd && rd.avgViewSeconds !== null ? formatDuration(rd.avgViewSeconds) : null;
            return (
              <tr key={v.videoId}>
                <th scope="row" data-label={r.col.video} className="rd-title">
                  <span>{title}</span>
                  {v.format === "short" && <span className="rd-badge">{r.shortBadge}</span>}
                  <span className="rd-links">
                    <Link href={`${videosHref}/${encodeURIComponent(v.videoId)}`} aria-label={fmt(r.detailsFor, { title })}>
                      {r.details}
                    </Link>
                    {watchUrl && (
                      <a href={watchUrl} target="_blank" rel="noopener noreferrer" aria-label={fmt(r.watchOnYoutube, { title })}>
                        YouTube <ExternalLink size={12} aria-hidden />
                      </a>
                    )}
                  </span>
                </th>
                <td data-label={r.col.published}>{dayOf(v.publishedAt)}</td>
                <td data-label={r.col.views} className="rd-num">
                  {rd && rd.views !== null ? formatCount(rd.views, locale) : <span className="rd-unknown">{r.notMeasured}</span>}
                </td>
                <td data-label={r.col.watch} className="rd-num">
                  {rd && rd.watchMinutes !== null ? fmt(r.hoursUnit, { n: formatHours(rd.watchMinutes / 60, locale) }) : <span className="rd-unknown">{r.notMeasured}</span>}
                </td>
                <td data-label={r.col.duration} className="rd-num">
                  {dur ?? <span className="rd-unknown">{r.notMeasured}</span>}
                </td>
                <td data-label={r.col.reading}>
                  {rd === null ? (
                    <span className="rd-unknown">{r.videoNotMeasured}</span>
                  ) : rd.daysAfterPublish === null ? (
                    fmt(r.readingDate, { date: rd.date })
                  ) : rd.daysAfterPublish === 0 ? (
                    fmt(r.readingSameDay, { date: rd.date })
                  ) : (
                    fmt(r.readingAfter, { date: rd.date, n: rd.daysAfterPublish })
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function privacyWord(privacy: string | null, p: ReturnType<typeof useI18n>["t"]["resultsDashboard"]["privacy"]): string {
  switch ((privacy ?? "").toLowerCase()) {
    case "private":
      return p.private;
    case "unlisted":
      return p.unlisted;
    case "public":
      return p.public;
    case "self_only":
      return p.selfOnly;
    default:
      return p.notRecorded;
  }
}

export function HistoryList({ entries, truncated, requests }: { entries: readonly HistoryEntry[]; truncated: boolean; requests: ResultsPayload["sources"]["requests"] }) {
  const { t, locale, fmt } = useI18n();
  const r = t.resultsDashboard;
  const reasons = t.publish.reasons as Record<string, string>;
  return (
    <section className="rd-section" aria-labelledby="rd-history-h">
      <h2 id="rd-history-h" className="rd-h">{r.historyTitle}</h2>
      <p className="rd-small">{r.historyNote}</p>
      {requests === "unavailable" && <p className="rd-small" role="status">{r.historyRequestsUnavailable}</p>}
      {requests === "failed" && <p className="rd-small" role="status">{r.historyRequestsFailed}</p>}
      {entries.length === 0 ? (
        <p className="rd-small">{r.historyEmpty}</p>
      ) : (
        <ul className="rd-history">
          {entries.map((e) => {
            const reason = knownReason(e.reason);
            return (
              <li key={e.key}>
                <div className="rd-history-main">
                  <span className="rd-history-video">{e.videoTitle ?? r.untitled}</span>
                  <span className="rd-history-where">
                    {r.to} {r.platform[e.platform]}
                    {" · "}
                    {e.target ?? r.targetUnknown}
                  </span>
                </div>
                <div className="rd-history-meta">
                  <span className="rd-chip" data-status={e.status}>{r.status[e.status]}</span>
                  <span className="rd-chip">{r.kind[e.kind]}</span>
                  <span className="rd-chip">{privacyWord(e.privacy, r.privacy)}</span>
                  <time dateTime={e.at}>
                    {dayOf(e.at)} · {relativeTime(e.at, locale)}
                  </time>
                  {e.url && (
                    <a href={e.url} target="_blank" rel="noopener noreferrer">
                      {t.publish.openPost} <ExternalLink size={12} aria-hidden />
                    </a>
                  )}
                </div>
                {(e.status === "failed" || e.status === "refused") && <p className="rd-small">{reason ? reasons[reason] : reasons.worker_error}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {truncated && <p className="rd-small">{fmt(r.historyTruncated, { max: entries.length })}</p>}
    </section>
  );
}

export function PlatformCards({ cards, manageHref }: { cards: readonly PlatformCard[]; manageHref: string }) {
  const { t, fmt } = useI18n();
  const r = t.resultsDashboard;
  return (
    <section className="rd-section" aria-labelledby="rd-platforms-h">
      <h2 id="rd-platforms-h" className="rd-h">{r.platformsTitle}</h2>
      <p className="rd-small">{r.platformsNote}</p>
      <ul className="rd-cards">
        {cards.map((c) => (
          <li key={c.id} className="rd-card" data-state={c.state}>
            <h3 className="rd-card-name">{r.platform[c.id]}</h3>
            <p className="rd-card-state">{r.platformState[c.state]}</p>
            {c.connected !== null && c.connected > 0 && <p className="rd-small">{fmt(r.connectedCount, { n: c.connected })}</p>}
            {(c.state === "not_connected" || c.state === "connected_results_coming") && (
              <Link href={manageHref} className="rd-card-link">
                {r.manageAccounts}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
