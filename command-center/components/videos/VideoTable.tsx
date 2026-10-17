"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Film } from "lucide-react";
import { num, relativeTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import type { VideoWithMetrics } from "@/app/(app)/[channel]/videos/page";

const PRIVACY_FILTERS = ["all", "public", "unlisted", "private"] as const;
type PrivacyFilter = (typeof PRIVACY_FILTERS)[number];

/**
 * Client-side searchable / filterable table for the video library. Receives the
 * server-fetched rows (video + latest metrics snapshot) as props and never
 * fetches on its own — it only filters what the server already resolved.
 */
export function VideoTable({ rows }: { rows: VideoWithMetrics[] }) {
  const path = useChannelPath();
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [privacy, setPrivacy] = useState<PrivacyFilter>("all");

  // Filter values are stable logic keys; only the displayed label is localized.
  const filterLabel: Record<PrivacyFilter, string> = {
    all: t.videos.filterAll,
    public: t.videos.filterPublic,
    unlisted: t.videos.filterUnlisted,
    private: t.videos.filterPrivate,
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (privacy !== "all" && (r.privacy ?? "").toLowerCase() !== privacy) return false;
      if (!q) return true;
      return (
        (r.title ?? "").toLowerCase().includes(q) ||
        (r.topic ?? "").toLowerCase().includes(q) ||
        r.video_id.toLowerCase().includes(q)
      );
    });
  }, [rows, query, privacy]);

  return (
    <div className="flex flex-col">
      <div className="vt-tools">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.videos.search}
          className="vt-search"
        />
        <div role="group" aria-label={t.videos.thPrivacy} className="flex flex-wrap gap-1.5">
          {PRIVACY_FILTERS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPrivacy(p)}
              aria-pressed={privacy === p}
              className="ns-chip"
            >
              {filterLabel[p]}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="vt w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-muted)]">
              <th className="px-4 py-2 font-semibold">{t.videos.thTitle}</th>
              <th className="px-4 py-2 font-semibold">{t.videos.thTopic}</th>
              <th className="px-4 py-2 font-semibold">{t.videos.thPublished}</th>
              <th className="px-4 py-2 font-semibold">{t.videos.thPrivacy}</th>
              <th className="px-4 py-2 text-right font-semibold">{t.videos.thViews}</th>
              <th className="px-4 py-2 text-right font-semibold">{t.videos.thLikes}</th>
              <th className="px-4 py-2 text-right font-semibold">{t.videos.thComments}</th>
              <th className="px-4 py-2 text-right font-semibold">{t.videos.thAvgView}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center tnum text-xs text-[var(--color-muted)]"
                >
                  {t.videos.noMatch}
                </td>
              </tr>
            ) : (
              filtered.map((v) => (
                <tr
                  key={v.video_id}
                  className="border-b border-[var(--color-border)]/50 transition-colors hover:bg-[var(--color-panel-2)]"
                >
                  <td className="px-4 py-2 text-[var(--color-fg)]">
                    <span className="vt-title">
                    {/* A small frame: the video's shape (a Short is upright) and its place in the list. */}
                    <span aria-hidden className="vt-frame" data-format={v.video_format === "short" ? "short" : "long"}>
                      <Film className="size-3.5" strokeWidth={1.5} />
                    </span>
                    <Link
                      href={path(`/videos/${v.video_id}`)}
                      className="hover:text-[var(--color-primary)]"
                    >
                      {v.title ?? v.video_id}
                    </Link>
                    {v.video_format === "short" && (
                      <span
                        className="ml-2 rounded border px-1.5 py-0.5 align-middle text-xs font-semibold"
                        style={{
                          borderColor: "var(--color-primary-dim)",
                          color: "var(--color-primary)",
                        }}
                      >
                        {t.videos.formatShort}
                      </span>
                    )}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-[var(--color-muted)]">{v.topic ?? t.common.na}</td>
                  <td className="px-4 py-2 tnum text-xs text-[var(--color-muted)]">
                    {relativeTime(v.published_at, locale)}
                  </td>
                  <td className="px-4 py-2 tnum text-xs text-[var(--color-muted)]">
                    {v.privacy ?? t.common.na}
                  </td>
                  <td className="px-4 py-2 text-right tnum tabular-nums text-[var(--color-fg)]">
                    {num(v.metrics?.views)}
                  </td>
                  <td className="px-4 py-2 text-right tnum tabular-nums text-[var(--color-muted)]">
                    {num(v.metrics?.likes)}
                  </td>
                  <td className="px-4 py-2 text-right tnum tabular-nums text-[var(--color-muted)]">
                    {num(v.metrics?.comment_count)}
                  </td>
                  <td className="px-4 py-2 text-right tnum tabular-nums text-[var(--color-muted)]">
                    {num(v.metrics?.average_view_duration_seconds)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="border-t border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-muted)]">
        {fmt(t.videos.count, { shown: filtered.length, total: rows.length })}
      </div>
    </div>
  );
}
