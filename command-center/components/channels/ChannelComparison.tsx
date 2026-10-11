"use client";

import { useI18n } from "@/lib/i18n/context";
import { EmptyState } from "@/components/ui";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { ChannelMark } from "@/components/channels/ChannelMark";
import { num, relativeTime } from "@/lib/format";
import type { ChannelStats } from "@/lib/channels";

/**
 * Cross-channel comparison.
 *
 * Only figures that mean the same thing on every channel appear here. Views
 * read "unknown" rather than 0 where no video of that channel has a metrics
 * snapshot yet — a channel with unpolled videos has unknown views, and drawing
 * that as zero makes a working channel look dead. There is deliberately no
 * blended score mixing views with cadence: that number would rank channels by
 * an arithmetic accident.
 *
 * A ledger on a wide screen; on a phone each channel folds into its own small
 * block of labelled lines, so nothing scrolls sideways.
 */
export function ChannelComparison({ stats, thumbnails = {} }: { stats: ChannelStats[]; thumbnails?: Record<string, string | null> }) {
  const { t } = useI18n();
  if (stats.length === 0) return <EmptyState>{t.channels.empty}</EmptyState>;

  return (
    <div className="flex flex-col gap-4">
      <table className="g2-ledger">
        <thead>
          <tr>
            <th scope="col">{t.channels.channel}</th>
            <th scope="col">{t.channels.status}</th>
            <th scope="col" className="num">{t.channels.videos}</th>
            <th scope="col" className="num">{t.channels.views}</th>
            <th scope="col" className="num">{t.channels.avgViews}</th>
            <th scope="col" className="num">{t.channels.cadence}</th>
            <th scope="col">{t.channels.lastPublished}</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.channelId}>
              <td>
                <span className="g2-ledger-name">
                  <ChannelMark name={s.name} thumbnail={thumbnails[s.channelId] ?? null} size="sm" />
                  <span>
                    <a href={`#channel-${encodeURIComponent(s.channelId)}`}>{s.name}</a>
                    <small className="mono">{s.channelId}</small>
                  </span>
                </span>
              </td>
              <td data-label={t.channels.status}>
                <StatusLamp tone={s.status === "ACTIVE" ? "ok" : "idle"} label={s.status === "ACTIVE" ? t.channels.active : t.channels.paused} />
              </td>
              <td data-label={t.channels.videos} className="num">{num(s.videos)}</td>
              <td data-label={t.channels.views} className="num">
                {s.views === null ? <Unknown label={t.channels.unknown} /> : num(s.views)}
              </td>
              <td data-label={t.channels.avgViews} className="num">
                {s.avgViews === null ? <Unknown label={t.channels.unknown} /> : num(s.avgViews)}
              </td>
              <td data-label={t.channels.cadence} className="num">
                {s.daysPerVideo === null ? <Unknown label={t.channels.unknown} /> : s.daysPerVideo}
              </td>
              <td data-label={t.channels.lastPublished} className="dim">
                {s.lastPublishedAt ? relativeTime(s.lastPublishedAt) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="g2-note">{t.channels.comparisonNote}</p>
    </div>
  );
}

function Unknown({ label }: { label: string }) {
  return <span className="dim">{label}</span>;
}
