"use client";

import { useMemo } from "react";
import { useRealtimeEvents } from "@/lib/useRealtimeEvents";
import type { ChannelScope } from "@/lib/channels";
import { subsystemHealth, overallStatus, type SubsystemKey, type Subsystem } from "@/lib/intelligence";
import { relativeTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import type { Dictionary } from "@/lib/i18n";
import type { SystemEventRow } from "@/lib/types";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";

const NAME_KEY: Record<SubsystemKey, keyof Dictionary["ops"]> = {
  youtube: "subYoutube",
  supabase: "subSupabase",
  ai: "subAi",
  realtime: "subRealtime",
  scheduler: "subScheduler",
  storage: "subStorage",
};

const STATE_KEY: Record<Subsystem["state"], keyof Dictionary["ops"]> = {
  operational: "stOperational",
  degraded: "stDegraded",
  offline: "stOffline",
  unknown: "stUnknown",
};

/**
 * Subsystem status board. Each subsystem's state is derived from real event
 * presence/recency (see lib/intelligence). Only the affected subsystem shows
 * warning/error — the whole board never turns red for one failure. Realtime
 * reflects the live connection state.
 */
export function SystemStatus({
  initial,
  dbOk,
  scope,
}: {
  initial: SystemEventRow[];
  dbOk: boolean;
  /** The page's channel scope — live events outside it are dropped. */
  scope: ChannelScope;
}) {
  const { t } = useI18n();
  const { events, connected } = useRealtimeEvents(initial, "chronos_status", scope);
  const subs = useMemo(() => subsystemHealth(events, dbOk, connected ?? true), [events, dbOk, connected]);
  const overall = overallStatus(subs);

  const banner =
    overall === "operational" ? t.ops.allOperational : overall === "degraded" ? t.ops.someDegraded : t.ops.someOffline;
  const bannerTone: LampTone = overall === "operational" ? "ok" : overall === "degraded" ? "warn" : "fail";

  return (
    <div className="flex flex-col gap-3 p-4">
      <StatusLamp tone={bannerTone} label={banner} size="md" />
      <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {subs.map((s) => {
          return (
            <li key={s.key} className="flex items-center justify-between gap-2 rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2">
              <span className="text-[13px] text-[var(--color-fg)]">{String(t.ops[NAME_KEY[s.key]])}</span>
              <span className="flex items-center gap-3">
                {s.lastSuccess && (
                  <span className="mono hidden text-[10px] text-[var(--color-muted)] sm:inline">{relativeTime(s.lastSuccess)}</span>
                )}
                <StatusLamp tone={s.tone as LampTone} label={String(t.ops[STATE_KEY[s.state]])} />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
