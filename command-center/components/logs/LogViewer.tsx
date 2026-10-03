"use client";

import { useMemo, useState } from "react";
import { statusTone, timeOfDay } from "@/lib/format";
import type { SystemEventRow } from "@/lib/types";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";

type LevelKey = "SUCCESS" | "INFO" | "ERROR";

/** tone → canonical level key + colour. The key is stable logic; the shown
 *  label is localized separately so filtering never depends on language. */
const LEVEL: Record<string, { key: LevelKey; color: string }> = {
  ok: { key: "SUCCESS", color: "var(--color-ok)" },
  run: { key: "INFO", color: "var(--color-primary)" },
  fail: { key: "ERROR", color: "var(--color-fail)" },
  idle: { key: "INFO", color: "var(--color-muted)" },
};

export function LogViewer({ rows }: { rows: SystemEventRow[] }) {
  const { t } = useI18n();
  const agents = useMemo(
    () => Array.from(new Set(rows.map((r) => r.agent).filter(Boolean))) as string[],
    [rows],
  );
  const [agent, setAgent] = useState("");
  const [level, setLevel] = useState<"" | LevelKey>("");
  const [q, setQ] = useState("");

  const levelLabel: Record<LevelKey, string> = {
    SUCCESS: t.logs.lvSuccess,
    INFO: t.logs.lvInfo,
    ERROR: t.logs.lvError,
  };

  const filtered = rows.filter((r) => {
    if (agent && r.agent !== agent) return false;
    if (level && LEVEL[statusTone(r.status)].key !== level) return false;
    if (q && !`${r.event} ${r.agent ?? ""} ${JSON.stringify(r.metadata ?? {})}`.toLowerCase().includes(q.toLowerCase()))
      return false;
    return true;
  });

  const select =
    "rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1 tnum text-xs outline-none transition-colors focus:border-[var(--color-primary)]";

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <input
          placeholder={t.logs.filter}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className={select + " flex-1 min-w-[120px]"}
        />
        <select value={agent} onChange={(e) => setAgent(e.target.value)} className={select}>
          <option value="">{t.logs.allAgents}</option>
          {agents.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select value={level} onChange={(e) => setLevel(e.target.value as "" | LevelKey)} className={select}>
          <option value="">{t.logs.allLevels}</option>
          <option value="SUCCESS">{levelLabel.SUCCESS}</option>
          <option value="INFO">{levelLabel.INFO}</option>
          <option value="ERROR">{levelLabel.ERROR}</option>
        </select>
        <span className="tnum text-xs text-[var(--color-muted)]">{fmt(t.logs.lines, { n: filtered.length })}</span>
      </div>
      <ol className="min-h-0 flex-1 divide-y divide-[var(--color-border)] overflow-y-auto">
        {filtered.length === 0 && (
          <li className="p-6 text-center tnum text-xs text-[var(--color-muted)]">{t.logs.noMatch}</li>
        )}
        {filtered.map((r, i) => {
          const lv = LEVEL[statusTone(r.status)];
          return (
            <li key={`${r.event_key}-${i}`} className="flex items-center gap-3 px-4 py-1.5 tnum text-xs">
              <span className="w-16 shrink-0 text-[var(--color-muted)]">{timeOfDay(r.ts)}</span>
              <span className="w-20 shrink-0 font-semibold" style={{ color: lv.color }}>{levelLabel[lv.key]}</span>
              <span className="w-28 shrink-0 truncate text-[var(--color-primary)]">{r.agent ?? t.common.system}</span>
              <span className="shrink-0 text-[var(--color-fg)]">{r.event}</span>
              <span className="truncate text-[var(--color-muted)]">
                {r.metadata ? JSON.stringify(r.metadata) : ""}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
