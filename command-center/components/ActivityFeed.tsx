"use client";

import { useMemo, useState } from "react";
import { useRealtimeEvents } from "@/lib/useRealtimeEvents";
import type { ChannelScope } from "@/lib/channels";
import { statusTone, timeOfDay } from "@/lib/format";
import { categorize, type EventCategory } from "@/lib/intelligence";
import type { SystemEventRow } from "@/lib/types";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";
import { Chip, ChipRow } from "@/components/ui/Chip";
import { useI18n } from "@/lib/i18n/context";
import { fmt, type Dictionary } from "@/lib/i18n";

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
        <span className="text-xs text-[var(--color-muted)]">
          {fmt(t.feed.events, { n: shown.length })}
        </span>
        <StatusLamp tone={live ? "run" : "idle"} label={live ? t.status.live : t.status.polled} live={live} />
      </div>

      <ChipRow label={fmt(t.feed.events, { n: shown.length })} wrap className="border-b border-[var(--color-border)] px-3 py-2">
        {FILTERS.map((f) => (
          <Chip key={f.key} pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {String(t.ops[f.label])}
          </Chip>
        ))}
      </ChipRow>

      <ol className="min-h-0 flex-1 divide-y divide-[var(--color-border)] overflow-y-auto">
        {shown.length === 0 && (
          <li className="p-6 text-center tnum text-xs text-[var(--color-muted)]">{t.feed.noEvents}</li>
        )}
        {shown.map((e) => {
          const tone = statusTone(e.status);
          return (
            <li
              key={e.event_key}
              className={`flex items-center gap-3 px-4 py-2 text-sm${freshKey === e.event_key ? " row-enter" : ""}`}
            >
              <span className="tnum w-16 shrink-0 text-xs text-[var(--color-muted)]">{timeOfDay(e.ts)}</span>
              <StatusLamp tone={tone as LampTone} label={{ ok: t.status.ok, run: t.status.running, fail: t.status.failed, idle: t.status.idle }[tone]} hideLabel />
              <span className="tnum shrink-0 text-xs text-[var(--color-primary)]">{e.agent ?? t.common.system}</span>
              <span className="truncate text-[var(--color-fg)]">{e.event}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
