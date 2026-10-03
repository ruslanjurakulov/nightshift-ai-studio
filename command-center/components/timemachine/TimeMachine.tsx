"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
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

const TONE_COLOR: Record<string, string> = {
  ok: "var(--color-ok)",
  run: "var(--color-primary)",
  fail: "var(--color-fail)",
  idle: "var(--color-idle)",
};

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
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((r) => {
          const on = range === r.key;
          return (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              className="btn-sky is-quiet pill border-transparent px-3 py-1.5 text-xs"
              style={{
                background: on ? "var(--color-panel-2)" : "transparent",
                color: on ? "var(--color-primary)" : "var(--color-muted)",
                border: on ? "1px solid var(--color-primary-dim)" : "1px solid var(--color-border)",
              }}
            >
              {String(t.ops[r.label])}
            </button>
          );
        })}
        {range === "custom" && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-[var(--color-muted)]">{t.ops.tmFrom}</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1 mono text-xs outline-none focus:border-[var(--color-primary)]" />
            <label className="text-xs text-[var(--color-muted)]">{t.ops.tmTo}</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1 mono text-xs outline-none focus:border-[var(--color-primary)]" />
          </div>
        )}
        <span className="tnum ml-auto text-xs text-[var(--color-muted)]">{fmt(t.ops.tmEvents, { n: events.length })}</span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="panel overflow-hidden lg:col-span-2">
          {groups.length === 0 ? (
            <div className="p-8 text-center tnum text-xs text-[var(--color-muted)]">{t.ops.tmEmpty}</div>
          ) : (
            <div className="max-h-[62vh] overflow-y-auto p-4">
              {groups.map(([day, rows]) => (
                <div key={day} className="mb-4 last:mb-0">
                  <div className="mb-2 text-xs text-[var(--color-muted)]">{day}</div>
                  <ol className="relative ml-2 border-l border-[var(--color-border)]">
                    {rows.map((e) => {
                      const tone = statusTone(e.status);
                      const on = selected?.event_key === e.event_key;
                      return (
                        <li key={e.event_key} className="relative pl-5">
                          <span
                            className="absolute -left-[5px] top-2 size-2 rounded-full"
                            style={{ background: TONE_COLOR[tone], boxShadow: `0 0 6px ${TONE_COLOR[tone]}` }}
                          />
                          <button
                            type="button"
                            onClick={() => setSelected(e)}
                            className="btn-sky is-quiet pill my-0.5 w-full justify-start gap-3 border-transparent px-3 py-2 text-left text-sm"
                            style={{ background: on ? "var(--color-panel-2)" : "transparent" }}
                          >
                            <span className="tnum w-16 shrink-0 text-xs text-[var(--color-muted)]">{timeOfDay(e.ts)}</span>
                            <span className="tnum shrink-0 text-xs text-[var(--color-primary)]">{e.agent ?? t.common.system}</span>
                            <span className="truncate text-[var(--color-fg)]">{e.event}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel p-5 sm:p-6">
          <div className="mb-3 text-xs font-bold text-[var(--color-fg)]">{t.ops.tmDetails}</div>
          {!selected ? (
            <p className="tnum text-xs text-[var(--color-muted)]">{t.ops.tmSelectHint}</p>
          ) : (
            <dl className="flex flex-col gap-2">
              {detailRows.map(([k, v]) => (
                <div key={k} className="flex flex-col gap-0.5 border-b border-[var(--color-border)]/60 pb-2 last:border-0">
                  <dt className="text-xs text-[var(--color-muted)]">{k}</dt>
                  <dd className="tnum break-words text-xs text-[var(--color-fg)]">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}
