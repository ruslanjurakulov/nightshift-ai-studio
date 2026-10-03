"use client";

import { useMemo, useState } from "react";
import { relativeTime, timeOfDay } from "@/lib/format";
import type { SystemEventRow } from "@/lib/types";
import { EmptyState } from "@/components/ui";
import { useI18n } from "@/lib/i18n/context";

/** Pull a human-readable error string out of an event's jsonb metadata:
 *  `metadata.error` when present, otherwise the whole metadata stringified.
 *  Never interprets keys — the backend already redacts sensitive ones. */
function errorText(metadata: Record<string, unknown> | null): string {
  if (!metadata) return "—";
  const err = metadata["error"];
  if (typeof err === "string" && err.trim()) return err;
  try {
    const json = JSON.stringify(metadata);
    return json && json !== "{}" ? json : "—";
  } catch {
    return "—";
  }
}

/** All rows handed here are already failures (see errors/page.tsx). Severity is
 *  derived: `.failed` events (or failed/error status) are ERROR. */
function isError(e: SystemEventRow): boolean {
  return (
    e.event.endsWith(".failed") ||
    (e.status ?? "").toLowerCase() === "failed" ||
    (e.status ?? "").toLowerCase() === "error"
  );
}

/**
 * Client-side filterable table of failure events. Free-text filter matches
 * against agent, event, ids, and the error text so an operator can narrow to a
 * component or a specific failure without a round-trip.
 */
export function ErrorTable({ rows }: { rows: SystemEventRow[] }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((e) => {
      const hay = [
        e.agent,
        e.event,
        e.video_id,
        e.job_id,
        e.status,
        errorText(e.metadata),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-2.5">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.errors.filter}
          className="tnum w-full max-w-md rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-1.5 text-xs text-[var(--color-fg)] outline-none transition-colors placeholder:text-[var(--color-muted)] focus:border-[var(--color-primary)]"
        />
        <span className="shrink-0 text-xs text-[var(--color-muted)]">
          {filtered.length} / {rows.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState>{rows.length === 0 ? t.errors.noneClean : t.errors.noMatch}</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-muted)]">
                <th className="px-4 py-2 font-semibold">{t.errors.thWhen}</th>
                <th className="px-4 py-2 font-semibold">{t.errors.thComponent}</th>
                <th className="px-4 py-2 font-semibold">{t.errors.thEvent}</th>
                <th className="px-4 py-2 font-semibold">{t.errors.thRelated}</th>
                <th className="px-4 py-2 font-semibold">{t.errors.thMessage}</th>
                <th className="px-4 py-2 font-semibold">{t.errors.thSeverity}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.event_key} className="border-b border-[var(--color-border)]/50 align-top transition-colors hover:bg-[var(--color-panel-2)]">
                  <td className="whitespace-nowrap px-4 py-2 tnum text-xs text-[var(--color-muted)]">
                    <div>{relativeTime(e.ts)}</div>
                    <div className="text-xs opacity-70">{timeOfDay(e.ts)}</div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 tnum text-xs text-[var(--color-primary)]">
                    {e.agent ?? t.common.system}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 tnum text-xs text-[var(--color-fg)]">
                    {e.event}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 tnum text-xs text-[var(--color-muted)]">
                    {e.video_id ? <div>vid: {e.video_id}</div> : null}
                    {e.job_id ? <div>job: {e.job_id}</div> : null}
                    {!e.video_id && !e.job_id ? "—" : null}
                  </td>
                  <td className="px-4 py-2 tnum text-xs text-[var(--color-fail)]">
                    <span className="block max-w-xl break-words">{errorText(e.metadata)}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 tnum text-xs font-semibold text-[var(--color-fail)]">
                    {isError(e) ? t.errors.sevError : t.errors.sevWarn}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
