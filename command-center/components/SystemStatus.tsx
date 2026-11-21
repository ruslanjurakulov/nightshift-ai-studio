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
import "@/app/(app)/app-pages-g5.css";

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
interface SystemStatusProps {
  initial: SystemEventRow[];
  dbOk: boolean;
  /** The page's channel scope — live events outside it are dropped. */
  scope: ChannelScope;
}

export function SystemStatus(props: SystemStatusProps) {
  // A different selected view must not inherit this panel's prior event seed or connection state.
  return <ScopedSystemStatus key={JSON.stringify(props.scope)} {...props} />;
}

function ScopedSystemStatus({ initial, dbOk, scope }: SystemStatusProps) {
  const { t, locale } = useI18n();
  const { events, connected } = useRealtimeEvents(initial, "chronos_status", scope);
  const subs = useMemo(() => subsystemHealth(events, dbOk, connected ?? true), [events, dbOk, connected]);
  const overall = overallStatus(subs);

  const banner = {
    operational: t.ops.allOperational,
    unknown: t.ops.someUnknown,
    degraded: t.ops.someDegraded,
    offline: t.ops.someOffline,
  }[overall];
  const bannerTone: LampTone = { operational: "ok", unknown: "idle", degraded: "warn", offline: "fail" }[overall] as LampTone;

  return (
    <div className="flex flex-col gap-4">
      <StatusLamp tone={bannerTone} label={banner} size="md" />
      <ul className="g5-tiles">
        {subs.map((s) => (
          <li key={s.key} className="g5-tile">
            <span className="g5-tile-name">{String(t.ops[NAME_KEY[s.key]])}</span>
            <span className="g5-tile-end">
              {s.lastSuccess && <span className="g5-tile-time hidden sm:inline">{relativeTime(s.lastSuccess, locale)}</span>}
              <StatusLamp tone={s.tone as LampTone} label={String(t.ops[STATE_KEY[s.state]])} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
