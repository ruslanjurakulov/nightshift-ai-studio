"use client";

import { useMemo, useState } from "react";
import { useRealtimeEvents } from "@/lib/useRealtimeEvents";
import type { ChannelScope } from "@/lib/channels";
import { ownerTimeOfDay, statusTone, timeOfDay } from "@/lib/format";
import { agentLabel } from "@/lib/agent-names";
import { categorize, type EventCategory } from "@/lib/intelligence";
import type { SystemEventRow } from "@/lib/types";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";
import { Chip, ChipRow } from "@/components/ui/Chip";
import { useI18n } from "@/lib/i18n/context";
import { StateBlock } from "@/components/states/StateBlock";
import "@/app/(app)/app-pages-g5.css";
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
  ownerClock = false,
}: {
  initial: SystemEventRow[];
  /** The operator's console: 24 hours in Tashkent time (hydration-safe). A customer keeps their own locale's clock. */
  ownerClock?: boolean;
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
    <div className="g5-feed">
      <div className="g5-feed-bar">
        <span className="g5-k">{fmt(t.feed.events, { n: shown.length })}</span>
        <StatusLamp tone={live ? "run" : "idle"} label={live ? t.status.live : t.status.polled} live={live} />
      </div>

      <ChipRow label={fmt(t.feed.events, { n: shown.length })} wrap className="pb-3">
        {FILTERS.map((f) => (
          <Chip key={f.key} pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {String(t.ops[f.label])}
          </Chip>
        ))}
      </ChipRow>

      {shown.length === 0 ? (
        <StateBlock tone="idle" compact>
          {t.feed.noEvents}
        </StateBlock>
      ) : (
        <ol className="g5-feed-list" style={{ maxHeight: 420 }} tabIndex={0} aria-label={fmt(t.feed.events, { n: shown.length })}>
          {shown.map((e) => {
            const tone = statusTone(e.status);
            return (
              <li key={e.event_key} className={`g5-feed-item${freshKey === e.event_key ? " row-enter" : ""}`}>
                <span className="g5-feed-t">{ownerClock ? ownerTimeOfDay(e.ts) : timeOfDay(e.ts)}</span>
                <StatusLamp tone={tone as LampTone} label={{ ok: t.status.ok, run: t.status.running, fail: t.status.failed, idle: t.status.idle }[tone]} hideLabel />
                <span className="g5-feed-agent" title={e.agent ?? undefined}>{e.agent ? agentLabel(e.agent, t.ownerShell.agentNames) : t.common.system}</span>
                <span className="g5-feed-event">{e.event}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
