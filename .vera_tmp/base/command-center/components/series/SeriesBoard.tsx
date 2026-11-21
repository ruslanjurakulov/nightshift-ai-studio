"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/ui";
import { Chip, ChipRow } from "@/components/ui/Chip";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { ErrorState } from "@/components/ReadError";
import type { Dictionary } from "@/lib/i18n";
import {
  AUTOMATION_LEVELS,
  PLATFORM_OPTIONS,
  cadenceSummary,
  seriesPlatforms,
  seriesStatus,
  type SeriesRow,
} from "@/lib/series";

type ChannelOption = { channel_id: string; name: string };

export function SeriesBoard({
  series,
  channels,
  tableMissing,
  readFailed = false,
  strings: s,
  canEdit = true,
}: {
  series: SeriesRow[];
  channels: ChannelOption[];
  tableMissing: boolean;
  /** The list query errored (not "table missing"): show that, not an empty list. */
  readFailed?: boolean;
  strings: Dictionary["series"];
  /** Editor+ in the organization being viewed — what /api/series requires.
   *  Presentation only; the route and RLS re-check. */
  canEdit?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    channel_id: channels[0]?.channel_id ?? "default",
    niche: "",
    format: "",
    long_per_week: "",
    shorts_per_day: "",
    automation_level: "manual",
    visual_style: "",
    voice_style: "",
    platforms: ["youtube"] as string[],
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function togglePlatform(p: string) {
    setForm((f) => ({
      ...f,
      platforms: f.platforms.includes(p)
        ? f.platforms.filter((x) => x !== p)
        : [...f.platforms, p],
    }));
  }

  async function submit() {
    if (!form.name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/series", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error === "table_missing" ? s.tableMissing : s.errorGeneric);
        return;
      }
      set("name", "");
      router.refresh();
    } catch {
      setError(s.errorGeneric);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(seriesId: string, status: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/series", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ series_id: seriesId, status }),
      });
      if (!res.ok) setError(s.errorGeneric);
      else router.refresh();
    } catch {
      setError(s.errorGeneric);
    } finally {
      setBusy(false);
    }
  }

  const input = "ns-field w-full";
  const label = "flex flex-col gap-1.5";

  return (
    <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <section className="ns-desk g2-desk g2-wizard" aria-labelledby="series-create-title">
        <h2 id="series-create-title" className="g2-h2 mb-5">
          {s.create}
        </h2>
        <div className="grid gap-4">
          <label className={label}>
            <span className="g2-label">{s.name}</span>
            <input
              className={input}
              value={form.name}
              placeholder={s.namePh}
              onChange={(e) => set("name", e.target.value)}
            />
          </label>
          <label className={label}>
            <span className="g2-label">{s.channel}</span>
            <select className={input} value={form.channel_id} onChange={(e) => set("channel_id", e.target.value)}>
              {channels.map((c) => (
                <option key={c.channel_id} value={c.channel_id}>
                  {c.name} ({c.channel_id})
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={label}>
              <span className="g2-label">{s.niche}</span>
              <input className={input} value={form.niche} onChange={(e) => set("niche", e.target.value)} />
            </label>
            <label className={label}>
              <span className="g2-label">{s.format}</span>
              <input className={input} value={form.format} placeholder={s.formatPh} onChange={(e) => set("format", e.target.value)} />
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={label}>
              <span className="g2-label">{s.longPerWeek}</span>
              <input className={input} type="number" min={0} value={form.long_per_week} onChange={(e) => set("long_per_week", e.target.value)} />
            </label>
            <label className={label}>
              <span className="g2-label">{s.shortsPerDay}</span>
              <input className={input} type="number" min={0} value={form.shorts_per_day} onChange={(e) => set("shorts_per_day", e.target.value)} />
            </label>
          </div>
          <div className="flex flex-col gap-2">
            <span className="g2-label" aria-hidden>{s.platforms}</span>
            <ChipRow label={s.platforms} wrap>
              {PLATFORM_OPTIONS.map((p) => (
                <Chip key={p} pressed={form.platforms.includes(p)} onClick={() => togglePlatform(p)} className="capitalize">
                  {p}
                </Chip>
              ))}
            </ChipRow>
          </div>
          <label className={label}>
            <span className="g2-label">{s.automation}</span>
            <select className={input} value={form.automation_level} onChange={(e) => set("automation_level", e.target.value)}>
              {AUTOMATION_LEVELS.map((a) => (
                <option key={a} value={a}>
                  {s.automationLevels[a]}
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={label}>
              <span className="g2-label">{s.visualStyle}</span>
              <input className={input} value={form.visual_style} onChange={(e) => set("visual_style", e.target.value)} />
            </label>
            <label className={label}>
              <span className="g2-label">{s.voiceStyle}</span>
              <input className={input} value={form.voice_style} onChange={(e) => set("voice_style", e.target.value)} />
            </label>
          </div>
          {error && <p className="g2-fail" role="alert">{error}</p>}
          {canEdit ? (
            <button
              type="button"
              onClick={submit}
              disabled={busy || !form.name.trim()}
              className="btn-primary mt-1 disabled:opacity-40"
            >
              {busy ? s.creating : s.submit}
            </button>
          ) : (
            <p className="g2-note">{s.readOnly}</p>
          )}
          <p className="g2-note">{s.pausedNote}</p>
        </div>
      </section>

      <section className="g2-section" aria-labelledby="series-list-title">
        <h2 id="series-list-title" className="g2-h2">
          {s.listTitle}
        </h2>
        {tableMissing ? (
          <EmptyState>{s.tableMissing}</EmptyState>
        ) : readFailed ? (
          <ErrorState />
        ) : series.length === 0 ? (
          <EmptyState>{s.empty}</EmptyState>
        ) : (
          <ul className="g2-rows">
            {series.map((row, i) => {
              const status = seriesStatus(row);
              const cadence = cadenceSummary(row);
              const platforms = seriesPlatforms(row);
              return (
                <li key={row.series_id} className="g2-row">
                  <span aria-hidden className="g2-row-no">{String(i + 1).padStart(2, "0")}</span>
                  <div className="g2-row-main">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <h3 className="g2-strong">{row.name}</h3>
                      <StatusLamp
                        tone={status === "ACTIVE" ? "ok" : status === "ARCHIVED" ? "idle" : "warn"}
                        label={s.statusLabels[status]}
                      />
                    </div>
                    <p className="g2-sub !mt-1 text-[0.875rem]">
                      {row.channel_id}
                      {row.niche ? ` · ${row.niche}` : ""}
                      {cadence ? ` · ${cadence}` : ""}
                    </p>
                    {(row.format || platforms.length > 0) && (
                      <p className="g2-note mt-1">
                        {row.format}
                        {platforms.length > 0 ? `  ·  ${platforms.join(", ")}` : ""}
                      </p>
                    )}
                  </div>
                  {canEdit && (
                    <div className="g2-actions">
                      {status !== "ACTIVE" && (
                        <button type="button" onClick={() => setStatus(row.series_id, "ACTIVE")} disabled={busy} className="btn-quiet disabled:opacity-40">
                          {s.activate}
                        </button>
                      )}
                      {status !== "PAUSED" && (
                        <button type="button" onClick={() => setStatus(row.series_id, "PAUSED")} disabled={busy} className="btn-quiet disabled:opacity-40">
                          {s.pause}
                        </button>
                      )}
                      {status !== "ARCHIVED" && (
                        <button type="button" onClick={() => setStatus(row.series_id, "ARCHIVED")} disabled={busy} className="btn-sky ghost rounded-[var(--ns-r-key)] px-4 disabled:opacity-40">
                          {s.archive}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
