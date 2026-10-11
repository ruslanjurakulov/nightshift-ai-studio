"use client";

import { useMemo, useState } from "react";
import { relativeTime, timeOfDay } from "@/lib/format";
import type { SystemEventRow } from "@/lib/types";
import Link from "next/link";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { StateBlock } from "@/components/states/StateBlock";
import { useChannelPath } from "@/lib/channels-client";
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
  const path = useChannelPath();
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
      <div className="g5-tools">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.errors.filter}
          aria-label={t.errors.filter}
          className="ns-field"
        />
        <span className="g5-note tnum" aria-live="polite">
          {filtered.length} / {rows.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        rows.length === 0 ? (
          <StateBlock
            tone="ok"
            title={t.errors.noneClean}
            actions={
              <Link href={path("/logs")} className="btn-quiet">
                {t.nav.logs}
              </Link>
            }
          />
        ) : (
          <StateBlock tone="idle" title={t.errors.noMatch} compact />
        )
      ) : (
        <ul className="g5-rows">
          {filtered.map((e) => (
            <li key={e.event_key} className="g5-row g5-fail">
              <div className="min-w-0">
                <div className="g5-fail-head">
                  <span className="g5-fail-event">{e.event}</span>
                  <span className="g5-fail-who">{e.agent ?? t.common.system}</span>
                  <StatusLamp tone={isError(e) ? "fail" : "warn"} label={isError(e) ? t.errors.sevError : t.errors.sevWarn} />
                </div>
                <p className="g5-fail-msg">{errorText(e.metadata)}</p>
                {(e.video_id || e.job_id) && (
                  <p className="g5-row-meta tnum">
                    {[e.video_id ? `${t.errors.thRelated}: ${e.video_id}` : null, e.job_id ? `job: ${e.job_id}` : null].filter(Boolean).join(" · ")}
                  </p>
                )}
              </div>
              <div className="g5-fail-when">
                <div>{relativeTime(e.ts)}</div>
                <div>{timeOfDay(e.ts)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
