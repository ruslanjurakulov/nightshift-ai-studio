"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorState } from "@/components/ReadError";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { LOCALES } from "@/lib/i18n/core";
import {
  DEFAULT_EPISODE_LENGTH_S,
  EPISODE_COUNTS,
  EPISODE_LENGTHS_S,
  MAX_TOPIC_CHARS,
  PLAN_LANGUAGES,
  cleanText,
  isSeriesId,
  newPlanKey,
  planLanguageFor,
  requestError,
  type RequestError,
} from "@/lib/seriesPlan";

export interface PlanChannelOption {
  channel_id: string;
  name: string;
}
export interface PlanSeriesOption {
  series_id: string;
  channel_id: string;
  name: string;
}
export interface RecentPlanRow {
  id: string;
  href: string;
  title: string;
  topic: string;
  status: string;
  nEpisodes: number;
}
export type RecentPlansView =
  | { state: "ok"; plans: RecentPlanRow[] }
  | { state: "unsupported" }
  | { state: "failed" };

/**
 * "Plan a series": the entry point to the Series Factory (docs/SERIES_FACTORY.md). Rendered only when the server flag
 * SERIES_FACTORY_ENABLED is on (the page decides; this component is never mounted otherwise).
 *
 * It calls the database function `request_series_plan` and nothing else: that writes one plan row and one queue row and stops
 * (CLAUDE.md rule 3). The function is granted to nobody until the owner decides, and the database's refusal of the call is shown as
 * "not available yet". Planning costs the customer nothing, so no price is asked or shown here. The topic is data for the planner and
 * the channel's niche comes from the database, never from this form.
 */
export function PlanSeriesPanel({
  channels,
  series,
  canEdit,
  planBase,
  recent,
  randomId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random()).slice(2) + String(Date.now())),
}: {
  channels: PlanChannelOption[];
  series: PlanSeriesOption[];
  canEdit: boolean;
  /** The path the plan pages live under, e.g. `/chronos/series`. */
  planBase: string;
  recent: RecentPlansView;
  randomId?: () => string;
}) {
  const { t, locale } = useI18n();
  const s = t.seriesPlan;
  const router = useRouter();
  const [channel, setChannel] = useState(channels[0]?.channel_id ?? "");
  const [topic, setTopic] = useState("");
  const [n, setN] = useState<number>(3);
  const [length, setLength] = useState<number>(DEFAULT_EPISODE_LENGTH_S);
  const [language, setLanguage] = useState<string>(planLanguageFor(locale));
  const [seriesId, setSeriesId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RequestError | "topic" | null>(null);
  // One key per distinct press: a double tap or a retry of the SAME request replays the first plan instead of queueing a second;
  // changing any field is a different request and gets a new key (the database refuses a key reused with other terms).
  const key = useRef<{ sig: string; value: string } | null>(null);

  const channelSeries = series.filter((x) => x.channel_id === channel);
  const input = "ns-field w-full";
  const label = "flex min-w-0 flex-col gap-1.5";

  function message(): string | null {
    if (error === null) return null;
    if (error === "topic") return fmt(s.entry.errors.invalid_topic, { n: MAX_TOPIC_CHARS });
    const m = s.entry.errors;
    switch (error.key) {
      case "rate_limited":
        return error.limit ? fmt(m.rate_limited, { n: error.limit }) : m.rate_limited_unknown;
      case "invalid_topic":
        return fmt(m.invalid_topic, { n: MAX_TOPIC_CHARS });
      default:
        return m[error.key];
    }
  }

  async function submit() {
    if (busy) return;
    const text = cleanText(topic, 10_000);
    if (text === "" || text.length > MAX_TOPIC_CHARS) {
      setError("topic");
      return;
    }
    const supabase = createClient();
    if (!supabase) {
      setError({ key: "failed" });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const args = {
        p_channel: channel,
        p_topic: text,
        p_n: n,
        p_language: language,
        p_duration_s: length,
        p_series: seriesId || null,
      };
      const sig = JSON.stringify(args);
      if (!key.current || key.current.sig !== sig) key.current = { sig, value: newPlanKey(randomId) };
      const { data, error: e } = await supabase.rpc("request_series_plan", { ...args, p_idem: key.current.value });
      if (e) {
        setError(requestError(e));
        return;
      }
      const id = (data as { id?: unknown } | null)?.id;
      if (!isSeriesId(id)) {
        setError({ key: "failed" });
        return;
      }
      router.push(`${planBase}/${id}`);
    } catch {
      setError({ key: "failed" });
    } finally {
      setBusy(false);
    }
  }

  const problem = message();
  const disabled = busy || !canEdit || channels.length === 0;

  return (
    <section className="ns-desk g2-desk g2-wizard min-w-0" aria-labelledby="plan-series-title" data-plan-series>
      <h2 id="plan-series-title" className="g2-h2 mb-2">
        {s.entry.title}
      </h2>
      <p className="m-0 mb-4 break-words text-sm text-[var(--color-muted)]">{s.entry.intro}</p>

      {!canEdit ? (
        <p role="note" className="m-0 mb-4 break-words text-sm">{s.entry.readOnly}</p>
      ) : channels.length === 0 ? (
        <p role="note" className="m-0 mb-4 break-words text-sm">{s.entry.noChannels}</p>
      ) : null}

      <form
        className="grid min-w-0 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className={label}>
          <span className="g2-label">{s.entry.channel}</span>
          <select
            className={input}
            value={channel}
            disabled={disabled}
            onChange={(e) => {
              setChannel(e.target.value);
              setSeriesId("");
            }}
          >
            {channels.map((c) => (
              <option key={c.channel_id} value={c.channel_id}>
                {c.name} ({c.channel_id})
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          <span className="g2-label">{s.entry.topic}</span>
          <input
            className={input}
            value={topic}
            maxLength={MAX_TOPIC_CHARS}
            disabled={disabled}
            placeholder={s.entry.topicPh}
            aria-describedby="plan-topic-hint"
            aria-invalid={error === "topic" || (error !== null && error.key === "invalid_topic") ? true : undefined}
            onChange={(e) => setTopic(e.target.value)}
          />
          <span id="plan-topic-hint" className="break-words text-xs text-[var(--color-muted)]">
            {fmt(s.entry.topicHint, { n: MAX_TOPIC_CHARS })}
          </span>
        </label>
        <div className="grid min-w-0 gap-4 sm:grid-cols-3">
          <label className={label}>
            <span className="g2-label">{s.entry.episodes}</span>
            <select className={input} value={n} disabled={disabled} onChange={(e) => setN(Number(e.target.value))}>
              {EPISODE_COUNTS.map((c) => (
                <option key={c} value={c}>
                  {fmt(s.entry.episodesOpt, { n: c })}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            <span className="g2-label">{s.entry.length}</span>
            <select className={input} value={length} disabled={disabled} onChange={(e) => setLength(Number(e.target.value))}>
              {EPISODE_LENGTHS_S.map((sec) => (
                <option key={sec} value={sec}>
                  {fmt(s.entry.lengthOpt, { n: sec / 60 })}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            <span className="g2-label">{s.entry.language}</span>
            <select className={input} value={language} disabled={disabled} onChange={(e) => setLanguage(e.target.value)}>
              {PLAN_LANGUAGES.map((l) => (
                <option key={l.name} value={l.name}>
                  {/* a language is named in itself, as the language picker does (lib/i18n/core.ts) */}
                  {LOCALES.find((x) => x.code === l.locale)?.label ?? l.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className={label}>
          <span className="g2-label">{s.entry.series}</span>
          <select className={input} value={seriesId} disabled={disabled} onChange={(e) => setSeriesId(e.target.value)}>
            <option value="">{s.entry.seriesNone}</option>
            {channelSeries.map((x) => (
              <option key={x.series_id} value={x.series_id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <p className="m-0 break-words text-xs text-[var(--color-muted)]">{s.entry.notice}</p>
        {problem ? (
          <p role="alert" className="m-0 break-words text-sm font-medium text-[var(--color-fail)]" data-plan-error={error === "topic" ? "topic" : error?.key}>
            {problem}
          </p>
        ) : null}
        <button type="submit" className="btn-primary min-h-12 w-full px-4 text-sm sm:w-fit" disabled={disabled || topic.trim() === ""} aria-busy={busy}>
          {busy ? s.entry.submitting : s.entry.submit}
        </button>
      </form>

      <section className="mt-8 min-w-0" aria-labelledby="recent-plans-title">
        <h3 id="recent-plans-title" className="g2-h2 mb-3">
          {s.recent.title}
        </h3>
        {recent.state === "failed" ? (
          <ErrorState message={s.recent.failed} />
        ) : recent.state === "unsupported" ? (
          <p className="m-0 break-words text-sm text-[var(--color-muted)]">{s.recent.unsupported}</p>
        ) : recent.plans.length === 0 ? (
          <p className="m-0 break-words text-sm text-[var(--color-muted)]">{s.recent.empty}</p>
        ) : (
          <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
            {recent.plans.map((p) => (
              <li key={p.id} className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-[var(--color-border)] py-2">
                <div className="min-w-0 flex-1 basis-48">
                  <p dir="auto" className="m-0 break-words text-sm font-medium">{p.title || p.topic || s.recent.untitled}</p>
                  <p className="m-0 break-words text-xs text-[var(--color-muted)]">
                    {fmt(s.recent.episodesCount, { n: p.nEpisodes })} ·{" "}
                    {(s.recent.status as Record<string, string>)[p.status] ?? p.status}
                  </p>
                </div>
                <Link href={p.href} className="btn-quiet min-h-11 px-3 text-sm">
                  {s.recent.open}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
