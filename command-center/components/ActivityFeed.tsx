"use client";

import { useMemo, useState } from "react";
import { useRealtimeEvents } from "@/lib/useRealtimeEvents";
import type { ChannelScope } from "@/lib/channels";
import { statusTone, timeOfDay } from "@/lib/format";
import { categorize, type EventCategory } from "@/lib/intelligence";
import type { SystemEventRow } from "@/lib/types";
import { StatusPill } from "@/components/ui";
import { useI18n } from "@/lib/i18n/context";
import { fmt, type Dictionary } from "@/lib/i18n";

const TONE_COLOR: Record<string, string> = {
  ok: "var(--color-ok)",
  run: "var(--color-primary)",
  fail: "var(--color-fail)",
  idle: "var(--color-idle)",
};

type Filter = "all" | EventCategory;
const FILTERS: { key: Filter; label: keyof Dictionary["ops"] }[] = [
  { key: "all", label: "filterAll" },
  { key: "system", label: "filterSystem" },
  { key: "ai", label: "filterAi" },
  { key: "video", label: "filterVideo" },
  { key: "analytics", label: "filterAnalytics" },
  { key: "error", label: "filterErrors" },
];

/**
 * Live mission-control feed. Seeded with server-fetched events, then live via
 * Supabase Realtime — real events only. New arrivals animate in; category
 * filters (derived from real event names) let an operator narrow the stream.
 */
export function ActivityFeed({
  initial,
  scope,
}: {
  initial: SystemEventRow[];
  /** The page's channel scope — live events outside it are dropped. */
  scope: ChannelScope;
}) {
  const { t } = useI18n();
  const { events, connected, freshKey } = useRealtimeEvents(initial, "system_events_feed", scope);
  const [filter, setFilter] = useState<Filter>("all");
  const live = connected === true;

  const shown = useMemo(
    () => (filter === "all" ? events : events.filter((e) => categorize(e) === filter)),
    [events, filter],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
          {fmt(t.feed.events, { n: shown.length })}
        </span>
        <StatusPill tone={live ? "run" : "idle"} label={live ? t.status.live : t.status.polled} live={live} />
      </div>

      <div className="flex flex-wrap gap-1 border-b border-[var(--color-border)] px-3 py-1.5">
        {FILTERS.map((f) => {
          const on = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className="btn-sky is-quiet pill border-transparent px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.22em]"
              style={{
                background: on ? "var(--color-panel-2)" : "transparent",
                color: on ? "var(--color-primary)" : "var(--color-muted)",
                border: on ? "1px solid var(--color-primary-dim)" : "1px solid transparent",
              }}
            >
              {String(t.ops[f.label])}
            </button>
          );
        })}
      </div>

      <ol className="min-h-0 flex-1 divide-y divide-[var(--color-border)] overflow-y-auto">
        {shown.length === 0 && (
          <li className="p-6 text-center mono text-xs text-[var(--color-muted)]">{t.feed.noEvents}</li>
        )}
        {shown.map((e) => {
          const tone = statusTone(e.status);
          return (
            <li
              key={e.event_key}
              className={`flex items-center gap-3 px-4 py-2 text-sm${freshKey === e.event_key ? " row-enter" : ""}`}
            >
              <span className="mono w-16 shrink-0 text-[10px] text-[var(--color-muted)]">{timeOfDay(e.ts)}</span>
              <span
                className="glow-dot size-1.5 shrink-0 rounded-full"
                style={{ color: TONE_COLOR[tone], background: TONE_COLOR[tone] }}
              />
              <span className="mono shrink-0 text-[11px] text-[var(--color-primary)]">{e.agent ?? t.common.system}</span>
              <span className="truncate text-[var(--color-fg)]">{e.event}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
