"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import type { ChannelScheduleConfig } from "@/lib/types";

/**
 * Edit a channel's cadence and autopilot switch from the site.
 *
 * Two settings, both read straight by the scheduler (tools/list_channels.py):
 *
 * - **Autopilot on/off** → `schedule_config.enabled`. Off means the daily
 *   resolver skips this channel entirely (it also gates `is_runnable`). On the
 *   scheduler runs it at the hour below.
 * - **Publish hour (UTC)** → `schedule_config.publish_hour_utc`. Which hour the
 *   hourly cron treats this channel as due. Unset falls back to 15:00 UTC, so
 *   the select seeds to that when nothing is stored.
 *
 * It writes configuration only — nothing here renders or publishes. And it needs
 * one channel: with "All channels" selected there is no single target, so the
 * controls are disabled and the panel says to pick a channel, rather than
 * writing to a channel it cannot name.
 */
const DEFAULT_HOUR_UTC = 15;

export function ScheduleEditor({
  channelId,
  schedule,
}: {
  /** The scoped channel's id, or null when "All channels" is selected. */
  channelId: string | null;
  /** The channel's current schedule_config (may be null / partial). */
  schedule: ChannelScheduleConfig | null;
}) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<boolean>(schedule?.enabled !== false);
  const [hour, setHour] = useState<number>(
    typeof schedule?.publish_hour_utc === "number" ? schedule.publish_hour_utc : DEFAULT_HOUR_UTC,
  );
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const disabled = !channelId;

  async function save() {
    if (!channelId || state === "saving") return;
    const supabase = createClient();
    if (!supabase) return;
    setState("saving");
    const next: ChannelScheduleConfig = { enabled, publish_hour_utc: hour };
    const { error } = await supabase
      .from("channels")
      .update({ schedule_config: next, updated_at: new Date().toISOString() })
      .eq("channel_id", channelId);
    setState(error ? "error" : "saved");
  }

  return (
    <div className="panel flex flex-col gap-4 p-4">
      <div>
        <h2 className="t-section">{t.agents.schedTitle}</h2>
        <p className="mt-1 max-w-[72ch] text-[12px] leading-relaxed text-[var(--color-muted)]">
          {t.agents.schedHint}
        </p>
      </div>

      {disabled && (
        <p className="text-[13px] text-[var(--color-warn)]">{t.agents.schedPickChannel}</p>
      )}

      {/* Autopilot on/off */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-panel-2)] px-4 py-3">
        <div className="min-w-0">
          <div className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
            {t.agents.schedAutopilot}
          </div>
          <p className="m-0 mt-1 max-w-[52ch] text-[12px] leading-relaxed text-[var(--color-muted)]">
            {enabled ? t.agents.schedOnHint : t.agents.schedOffHint}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={disabled || state === "saving"}
          onClick={() => {
            setEnabled((v) => !v);
            if (state !== "idle") setState("idle");
          }}
          className="btn-sky pill shrink-0 px-4 py-2 text-[12px] disabled:opacity-50"
          style={{
            borderColor: enabled ? "var(--color-ok)" : "var(--color-border)",
            color: enabled ? "var(--color-ok)" : "var(--color-muted)",
          }}
        >
          {enabled ? t.agents.schedOn : t.agents.schedOff}
        </button>
      </div>

      {/* Publish hour */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label
          htmlFor="sched-hour"
          className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]"
        >
          {t.agents.schedHour}
        </label>
        <select
          id="sched-hour"
          value={hour}
          disabled={disabled || !enabled || state === "saving"}
          onChange={(e) => {
            setHour(Number(e.target.value));
            if (state !== "idle") setState("idle");
          }}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 mono text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] disabled:opacity-50"
        >
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              {String(h).padStart(2, "0")}:00 UTC
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={disabled || state === "saving"}
          className="btn-sky is-solid pill px-5 py-2 text-[13px] disabled:opacity-40"
        >
          {state === "saving" ? t.agents.schedSaving : t.agents.schedSave}
        </button>
        <span className="mono text-[11px]" aria-live="polite">
          {state === "saved" ? (
            <span className="text-[var(--color-ok)]">{t.agents.schedSaved}</span>
          ) : state === "error" ? (
            <span className="text-[var(--color-fail)]">{t.agents.schedFailed}</span>
          ) : null}
        </span>
      </div>
    </div>
  );
}
