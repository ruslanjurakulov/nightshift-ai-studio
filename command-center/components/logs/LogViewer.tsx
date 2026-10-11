"use client";

import { useMemo, useState } from "react";
import { statusTone, timeOfDay } from "@/lib/format";
import type { SystemEventRow } from "@/lib/types";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";

type LevelKey = "SUCCESS" | "INFO" | "ERROR";

/** tone → canonical level key + lamp. The key is stable logic; the shown
 *  label is localized separately so filtering never depends on language. */
const LEVEL: Record<string, { key: LevelKey; lamp: LampTone }> = {
  ok: { key: "SUCCESS", lamp: "ok" },
  run: { key: "INFO", lamp: "run" },
  fail: { key: "ERROR", lamp: "fail" },
  idle: { key: "INFO", lamp: "idle" },
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

  return (
    <div className="flex h-full flex-col">
      <div className="g4-logtools">
        <input
          type="search"
          aria-label={t.logs.filter}
          placeholder={t.logs.filter}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="ns-field w-full"
        />
        <select aria-label={t.logs.allAgents} value={agent} onChange={(e) => setAgent(e.target.value)} className="ns-field">
          <option value="">{t.logs.allAgents}</option>
          {agents.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select aria-label={t.logs.allLevels} value={level} onChange={(e) => setLevel(e.target.value as "" | LevelKey)} className="ns-field">
          <option value="">{t.logs.allLevels}</option>
          <option value="SUCCESS">{levelLabel.SUCCESS}</option>
          <option value="INFO">{levelLabel.INFO}</option>
          <option value="ERROR">{levelLabel.ERROR}</option>
        </select>
        <span className="tnum g4-muted text-sm" aria-live="polite">{fmt(t.logs.lines, { n: filtered.length })}</span>
      </div>
      <ol className="g4-logs scroll-focus min-h-0 flex-1" tabIndex={0} aria-label={t.logs.eventLog}>
        {filtered.length === 0 && (
          <li className="g4-muted p-6 text-center tnum">{t.logs.noMatch}</li>
        )}
        {filtered.map((r, i) => {
          const lv = LEVEL[statusTone(r.status)];
          return (
            <li key={`${r.event_key}-${i}`}>
              <span className="g4-log-meta">
                <span className="g4-muted">{timeOfDay(r.ts)}</span>
                <StatusLamp tone={lv.lamp} label={levelLabel[lv.key]} />
                <span className="truncate" style={{ color: "var(--ns-act-ink)" }}>{r.agent ?? t.common.system}</span>
              </span>
              <span className="text-[var(--color-fg)]" style={{ overflowWrap: "anywhere" }}>{r.event}</span>
              <span className="g4-log-data">{r.metadata ? JSON.stringify(r.metadata) : ""}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
