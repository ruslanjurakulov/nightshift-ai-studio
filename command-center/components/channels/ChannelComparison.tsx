"use client";

import { useI18n } from "@/lib/i18n/context";
import { EmptyState } from "@/components/ui";
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
 */
export function ChannelComparison({ stats }: { stats: ChannelStats[] }) {
  const { t } = useI18n();
  if (stats.length === 0) return <EmptyState>{t.channels.empty}</EmptyState>;

  return (
    <div className="flex flex-col gap-2">
      <div tabIndex={0} role="region" aria-label={t.common.scrollTable} className="scroll-focus overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-left">
          <thead>
            <tr className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
              <th className="px-4 py-2 font-semibold">{t.channels.channel}</th>
              <th className="px-4 py-2 font-semibold">{t.channels.status}</th>
              <th className="px-4 py-2 text-right font-semibold">{t.channels.videos}</th>
              <th className="px-4 py-2 text-right font-semibold">{t.channels.views}</th>
              <th className="px-4 py-2 text-right font-semibold">{t.channels.avgViews}</th>
              <th className="px-4 py-2 text-right font-semibold">{t.channels.cadence}</th>
              <th className="px-4 py-2 font-semibold">{t.channels.lastPublished}</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.channelId} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2">
                  <span className="block truncate text-[12px] text-[var(--color-fg)]">{s.name}</span>
                  <span className="mono block truncate text-[9px] text-[var(--color-muted)]">{s.channelId}</span>
                </td>
                <td className="px-4 py-2 mono text-[10px]" style={{ color: s.status === "ACTIVE" ? "var(--color-ok)" : "var(--color-muted)" }}>
                  {s.status === "ACTIVE" ? t.channels.active : t.channels.paused}
                </td>
                <td className="px-4 py-2 text-right mono text-[12px] tabular-nums">{num(s.videos)}</td>
                <td className="px-4 py-2 text-right mono text-[12px] tabular-nums">
                  {s.views === null ? <Unknown label={t.channels.unknown} /> : num(s.views)}
                </td>
                <td className="px-4 py-2 text-right mono text-[12px] tabular-nums">
                  {s.avgViews === null ? <Unknown label={t.channels.unknown} /> : num(s.avgViews)}
                </td>
                <td className="px-4 py-2 text-right mono text-[12px] tabular-nums">
                  {s.daysPerVideo === null ? <Unknown label={t.channels.unknown} /> : s.daysPerVideo}
                </td>
                <td className="px-4 py-2 mono text-[11px] text-[var(--color-muted)]">
                  {s.lastPublishedAt ? relativeTime(s.lastPublishedAt) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-4 pb-3 text-[11px] leading-relaxed text-[var(--color-muted)]">
        {t.channels.comparisonNote}
      </p>
    </div>
  );
}

function Unknown({ label }: { label: string }) {
  return <span className="mono text-[10px] text-[var(--color-muted)]">{label}</span>;
}
