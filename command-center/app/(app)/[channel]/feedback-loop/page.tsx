import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Panel, EmptyState, StatCard } from "@/components/ui";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { relativeTime } from "@/lib/format";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { fetchTopicScores, getChannelSelection } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import { fmt } from "@/lib/i18n";
import type { FeedbackSignalRow, TopicPerformanceRow } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function signalTone(signal: string): string {
  if (signal.startsWith("HIGH_")) return "var(--color-ok)";
  if (signal.startsWith("LOW_")) return "var(--color-fail)";
  return "var(--color-muted)";
}

export default async function FeedbackPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  // Scope every channel-owned query to the selected channel (view control;
  // RLS still decides what may be read at all).
  const selection = await getChannelSelection();

  const LOOP = [
    t.feedback.loop1,
    t.feedback.loop2,
    t.feedback.loop3,
    t.feedback.loop4,
    t.feedback.loop5,
    t.feedback.loop6,
    t.feedback.loop7,
  ];

  const supabase = await createClient();
  let signals: FeedbackSignalRow[] = [];
  let topics: TopicPerformanceRow[] = [];

  if (supabase) {
    const [sg, tp] = await Promise.all([
      scopeQuery(supabase.from("feedback_signals").select("*"), selection).order("analyzed_date", { ascending: false }).limit(200),
      fetchTopicScores(supabase, selection, 50),
    ]);
    signals = (sg.data as FeedbackSignalRow[]) ?? [];
    topics = tp;
  }

  const lastRun = signals[0]?.analyzed_date ?? null;

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="feedback" title={t.feedback.title} subtitle={t.feedback.subtitle} />

      {/* The loop, drawn from the real stages the backend runs */}
      <div className="panel overflow-x-auto p-4">
        <div className="flex min-w-max items-center gap-2">
          {LOOP.map((step, i) => (
            <div key={step} className="flex items-center gap-2">
              <span className="mono whitespace-nowrap rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2.5 py-1.5 text-[11px] text-[var(--color-fg)]">
                {step}
              </span>
              {i < LOOP.length - 1 && <span className="text-[var(--color-primary)]">→</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={t.feedback.scoredTopics} value={<AnimatedNumber value={topics.length} />} tone={topics.length ? "run" : "idle"} />
        <StatCard label={t.feedback.signalsRecorded} value={<AnimatedNumber value={signals.length} />} sub={t.feedback.mostRecent} />
        <StatCard label={t.feedback.lastAnalysis} value={lastRun ? relativeTime(lastRun) : t.common.dash} sub={lastRun ?? t.feedback.notRun} />
        <StatCard
          label={t.feedback.aboveAvg}
          value={<AnimatedNumber value={topics.filter((tp) => tp.score >= 50).length} />}
          tone="ok"
          sub={fmt(t.feedback.ofTopics, { n: topics.length })}
        />
      </div>

      <Panel title={t.feedback.learned}>
        {topics.length === 0 ? (
          <EmptyState>{t.feedback.emptyLearned}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
                  <th className="px-4 py-2 font-semibold">{t.feedback.thTopic}</th>
                  <th className="px-4 py-2 font-semibold">{t.feedback.thScore}</th>
                  <th className="px-4 py-2 font-semibold">{t.feedback.thVideos}</th>
                  <th className="px-4 py-2 font-semibold">{t.feedback.thReason}</th>
                  <th className="px-4 py-2 font-semibold">{t.feedback.thUpdated}</th>
                </tr>
              </thead>
              <tbody>
                {topics.map((tp) => (
                  <tr key={tp.topic} className="border-b border-[var(--color-border)]/50 transition-colors hover:bg-[var(--color-panel-2)]">
                    <td className="px-4 py-2 text-[var(--color-fg)]">{tp.topic}</td>
                    <td className="px-4 py-2 mono font-bold tabular-nums"
                      style={{ color: tp.score >= 50 ? "var(--color-ok)" : "var(--color-warn)" }}>
                      {tp.score.toFixed(0)}
                    </td>
                    <td className="px-4 py-2 mono text-[var(--color-muted)] tabular-nums">{tp.videos_analyzed}</td>
                    <td className="px-4 py-2 text-[11px] text-[var(--color-muted)]">{tp.reason ?? t.common.dash}</td>
                    <td className="px-4 py-2 mono text-[11px] text-[var(--color-muted)]">{relativeTime(tp.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={t.feedback.recentSignals}>
        {signals.length === 0 ? (
          <EmptyState>{t.feedback.noSignals}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
                  <th className="px-4 py-2 font-semibold">{t.feedback.sgSignal}</th>
                  <th className="px-4 py-2 font-semibold">{t.feedback.sgTopic}</th>
                  <th className="px-4 py-2 font-semibold">{t.feedback.sgVideo}</th>
                  <th className="px-4 py-2 font-semibold">{t.feedback.sgDetail}</th>
                  <th className="px-4 py-2 font-semibold">{t.feedback.sgAnalyzed}</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s, i) => (
                  <tr key={`${s.video_id}-${s.signal}-${i}`} className="border-b border-[var(--color-border)]/50 transition-colors hover:bg-[var(--color-panel-2)]">
                    <td className="px-4 py-2 mono text-[11px] font-semibold" style={{ color: signalTone(s.signal) }}>
                      {s.signal}
                    </td>
                    <td className="px-4 py-2 text-[var(--color-muted)]">{s.topic ?? t.common.dash}</td>
                    <td className="px-4 py-2 mono text-[11px] text-[var(--color-muted)]">{s.video_id}</td>
                    <td className="px-4 py-2 text-[11px] text-[var(--color-muted)]">{s.detail ?? t.common.dash}</td>
                    <td className="px-4 py-2 mono text-[11px] text-[var(--color-muted)]">{relativeTime(s.analyzed_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
