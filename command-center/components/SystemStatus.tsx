"use client";

import { useMemo } from "react";
import { useRealtimeEvents } from "@/lib/useRealtimeEvents";
import type { ChannelScope } from "@/lib/channels";
import { subsystemHealth, overallStatus, type SubsystemKey, type Subsystem } from "@/lib/intelligence";
import { relativeTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import type { Dictionary } from "@/lib/i18n";
import type { SystemEventRow } from "@/lib/types";

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

const TONE_COLOR: Record<string, string> = {
  ok: "var(--color-ok)",
  warn: "var(--color-warn)",
  fail: "var(--color-fail)",
  idle: "var(--color-idle)",
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
  const bannerColor = overall === "operational" ? "var(--color-ok)" : overall === "degraded" ? "var(--color-warn)" : "var(--color-fail)";

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <span className="glow-dot live-ring size-2 rounded-full" style={{ color: bannerColor, background: bannerColor }} />
        <span className="mono text-[11px] font-semibold tracking-wider" style={{ color: bannerColor }}>
          {banner}
        </span>
      </div>
      <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {subs.map((s) => {
          const color = TONE_COLOR[s.tone];
          return (
            <li key={s.key} className="flex items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5">
              <span className="flex items-center gap-2">
                <span className="size-1.5 rounded-full" style={{ background: color }} />
                <span className="text-[12px] text-[var(--color-fg)]">{String(t.ops[NAME_KEY[s.key]])}</span>
              </span>
              <span className="flex items-center gap-2">
                {s.lastSuccess && (
                  <span className="mono hidden text-[9px] text-[var(--color-muted)] sm:inline">{relativeTime(s.lastSuccess)}</span>
                )}
                <span className="text-[9px] font-semibold uppercase tracking-[0.22em]" style={{ color }}>
                  {String(t.ops[STATE_KEY[s.state]])}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
