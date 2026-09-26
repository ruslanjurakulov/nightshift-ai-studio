"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Panel, EmptyState } from "@/components/ui";
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
  strings: s,
  canEdit = true,
}: {
  series: SeriesRow[];
  channels: ChannelOption[];
  tableMissing: boolean;
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

  const input = "w-full rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-sm";

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
      <Panel title={s.create}>
        <div className="grid gap-2.5">
          <label className="grid gap-1 text-xs opacity-80">
            {s.name}
            <input
              className={input}
              value={form.name}
              placeholder={s.namePh}
              onChange={(e) => set("name", e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs opacity-80">
            {s.channel}
            <select className={input} value={form.channel_id} onChange={(e) => set("channel_id", e.target.value)}>
              {channels.map((c) => (
                <option key={c.channel_id} value={c.channel_id}>
                  {c.name} ({c.channel_id})
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1 text-xs opacity-80">
              {s.niche}
              <input className={input} value={form.niche} onChange={(e) => set("niche", e.target.value)} />
            </label>
            <label className="grid gap-1 text-xs opacity-80">
              {s.format}
              <input className={input} value={form.format} placeholder={s.formatPh} onChange={(e) => set("format", e.target.value)} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1 text-xs opacity-80">
              {s.longPerWeek}
              <input className={input} type="number" min={0} value={form.long_per_week} onChange={(e) => set("long_per_week", e.target.value)} />
            </label>
            <label className="grid gap-1 text-xs opacity-80">
              {s.shortsPerDay}
              <input className={input} type="number" min={0} value={form.shorts_per_day} onChange={(e) => set("shorts_per_day", e.target.value)} />
            </label>
          </div>
          <div className="grid gap-1 text-xs opacity-80">
            {s.platforms}
            <div className="flex flex-wrap gap-2">
              {PLATFORM_OPTIONS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => togglePlatform(p)}
                  className={`rounded-full border px-2.5 py-1 text-xs capitalize ${
                    form.platforms.includes(p)
                      ? "border-sky-400/60 bg-sky-400/15"
                      : "border-white/10 bg-white/5 opacity-70"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <label className="grid gap-1 text-xs opacity-80">
            {s.automation}
            <select className={input} value={form.automation_level} onChange={(e) => set("automation_level", e.target.value)}>
              {AUTOMATION_LEVELS.map((a) => (
                <option key={a} value={a}>
                  {s.automationLevels[a]}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1 text-xs opacity-80">
              {s.visualStyle}
              <input className={input} value={form.visual_style} onChange={(e) => set("visual_style", e.target.value)} />
            </label>
            <label className="grid gap-1 text-xs opacity-80">
              {s.voiceStyle}
              <input className={input} value={form.voice_style} onChange={(e) => set("voice_style", e.target.value)} />
            </label>
          </div>
          {error && <p className="text-xs text-rose-300">{error}</p>}
          {canEdit ? (
            <button
              type="button"
              onClick={submit}
              disabled={busy || !form.name.trim()}
              className="mt-1 rounded-md border border-sky-400/50 bg-sky-400/15 px-3 py-1.5 text-sm font-medium disabled:opacity-40"
            >
              {busy ? s.creating : s.submit}
            </button>
          ) : (
            <p className="mt-1 text-xs opacity-70">{s.readOnly}</p>
          )}
          <p className="text-[11px] opacity-50">{s.pausedNote}</p>
        </div>
      </Panel>

      <Panel title={s.listTitle}>
        {tableMissing ? (
          <EmptyState>{s.tableMissing}</EmptyState>
        ) : series.length === 0 ? (
          <EmptyState>{s.empty}</EmptyState>
        ) : (
          <div className="grid gap-2">
            {series.map((row) => {
              const status = seriesStatus(row);
              const cadence = cadenceSummary(row);
              const platforms = seriesPlatforms(row);
              return (
                <div key={row.series_id} className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{row.name}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] ${
                            status === "ACTIVE"
                              ? "bg-emerald-400/15 text-emerald-300"
                              : status === "ARCHIVED"
                                ? "bg-white/10 opacity-60"
                                : "bg-amber-400/15 text-amber-300"
                          }`}
                        >
                          {s.statusLabels[status]}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs opacity-70">
                        {row.channel_id}
                        {row.niche ? ` · ${row.niche}` : ""}
                        {cadence ? ` · ${cadence}` : ""}
                      </div>
                      {(row.format || platforms.length > 0) && (
                        <div className="mt-1 text-[11px] opacity-55">
                          {row.format}
                          {platforms.length > 0 ? `  ·  ${platforms.join(", ")}` : ""}
                        </div>
                      )}
                    </div>
                    {canEdit && (
                      <div className="flex gap-1.5">
                        {status !== "ACTIVE" && (
                          <button type="button" onClick={() => setStatus(row.series_id, "ACTIVE")} disabled={busy} className="rounded-md border border-emerald-400/40 bg-emerald-400/10 px-2 py-1 text-xs disabled:opacity-40">
                            {s.activate}
                          </button>
                        )}
                        {status !== "PAUSED" && (
                          <button type="button" onClick={() => setStatus(row.series_id, "PAUSED")} disabled={busy} className="rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-xs disabled:opacity-40">
                            {s.pause}
                          </button>
                        )}
                        {status !== "ARCHIVED" && (
                          <button type="button" onClick={() => setStatus(row.series_id, "ARCHIVED")} disabled={busy} className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs opacity-70 disabled:opacity-40">
                            {s.archive}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}
