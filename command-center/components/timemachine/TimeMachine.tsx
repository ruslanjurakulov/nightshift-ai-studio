"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { Chip, ChipRow } from "@/components/ui/Chip";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { fmt, type Dictionary } from "@/lib/i18n";
import type { SystemEventRow } from "@/lib/types";
import { parseStoredTime, statusTone, storedMs, timeOfDay } from "@/lib/format";

type RangeKey = "today" | "yesterday" | "7d" | "30d" | "custom";
const RANGES: { key: RangeKey; label: keyof Dictionary["ops"] }[] = [
  { key: "today", label: "rangeToday" },
  { key: "yesterday", label: "rangeYesterday" },
  { key: "7d", label: "range7d" },
  { key: "30d", label: "range30d" },
  { key: "custom", label: "rangeCustom" },
];


function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function bounds(range: RangeKey, from: string, to: string): [number, number] {
  const now = Date.now();
  const today = startOfDay(new Date()).getTime();
  switch (range) {
    case "today":
      return [today, now];
    case "yesterday":
      return [today - 86400000, today];
    case "7d":
      return [now - 7 * 86400000, now];
    case "30d":
      return [now - 30 * 86400000, now];
    case "custom": {
      const f = from ? new Date(from).getTime() : now - 86400000;
      const t = to ? new Date(to).getTime() + 86400000 - 1 : now;
      return [f, t];
    }
  }
}

/** Explore the real event history. All markers are stored system_events; the
 *  ranges only filter what was actually recorded — nothing is synthesized. */
export function TimeMachine({ initial }: { initial: SystemEventRow[] }) {
  const { t } = useI18n();
  const [range, setRange] = useState<RangeKey>("today");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selected, setSelected] = useState<SystemEventRow | null>(null);

  const [lo, hi] = bounds(range, from, to);
  const events = useMemo(
    () => initial.filter((e) => {
      const ts = (storedMs(e.ts) ?? 0);
      return ts >= lo && ts <= hi;
    }),
    [initial, lo, hi],
  );

  // Group by calendar day (events are newest-first).
  const groups = useMemo(() => {
    const map = new Map<string, SystemEventRow[]>();
    for (const e of events) {
      const key = (parseStoredTime(e.ts) ?? new Date(0)).toISOString().slice(0, 10);
      const arr = map.get(key);
      if (arr) arr.push(e);
      else map.set(key, [e]);
    }
    return Array.from(map.entries());
  }, [events]);

  const detailRows = selected
    ? ([
        ["event", selected.event],
        ["agent", selected.agent ?? "—"],
        ["status", selected.status ?? "—"],
        ["video_id", selected.video_id ?? "—"],
        ["job_id", selected.job_id ?? "—"],
        ["duration_ms", selected.duration_ms != null ? String(selected.duration_ms) : "—"],
        ["ts", selected.ts],
        ["metadata", selected.metadata ? JSON.stringify(selected.metadata) : "—"],
      ] as [string, string][])
    : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <ChipRow label={t.ops.timeMachineTitle} wrap className="g3-chips">
          {RANGES.map((r) => (
            <Chip key={r.key} pressed={range === r.key} onClick={() => setRange(r.key)}>
              {String(t.ops[r.label])}
            </Chip>
          ))}
        </ChipRow>
        {range === "custom" && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <label htmlFor="tm-from" className="text-sm text-[var(--color-muted)]">{t.ops.tmFrom}</label>
            <input id="tm-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="ns-field" />
            <label htmlFor="tm-to" className="text-sm text-[var(--color-muted)]">{t.ops.tmTo}</label>
            <input id="tm-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="ns-field" />
          </div>
        )}
        <span className="tnum ml-auto text-sm text-[var(--color-muted)]">{fmt(t.ops.tmEvents, { n: events.length })}</span>
      </div>

      <div className="g3-tm">
        <section aria-label={t.ops.timeMachineTitle} className="g3-section ns-desk">
          {groups.length === 0 ? (
            <p className="g3-note" style={{ border: 0, padding: 0 }}>{t.ops.tmEmpty}</p>
          ) : (
            <div className="g3-tm-scroll">
              {groups.map(([day, rows]) => (
                <div key={day} className="g3-tm-day">
                  <h3 className="g3-tm-date">{day}</h3>
                  <ol className="g3-tm-list">
                    {rows.map((e) => {
                      const tone = statusTone(e.status);
                      const on = selected?.event_key === e.event_key;
                      return (
                        <li key={e.event_key}>
                          <button type="button" onClick={() => setSelected(e)} aria-pressed={on} className="g3-tm-event">
                            <StatusLamp tone={tone} label={e.status ?? t.status.idle} hideLabel />
                            <span className="tnum g3-tm-time">{timeOfDay(e.ts)}</span>
                            <span className="g3-tm-agent">{e.agent ?? t.common.system}</span>
                            <span className="g3-tm-name">{e.event}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              ))}
            </div>
          )}
        </section>

        <section aria-label={t.ops.tmDetails} className="g3-section g3-tm-side">
          <h2 className="t-panel">{t.ops.tmDetails}</h2>
          {!selected ? (
            <p className="g3-sub m-0">{t.ops.tmSelectHint}</p>
          ) : (
            <dl className="g3-tm-facts">
              {detailRows.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd className="tnum">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      </div>
    </div>
  );
}
