import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Panel, StatCard, EmptyState } from "@/components/ui";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { ExplainScore } from "@/components/topics/ExplainScore";
import { num, decimal, relativeTime } from "@/lib/format";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { fetchTopicScores, getChannelContext, getChannelSelection } from "@/lib/channels-server";
import { ALL_CHANNELS, scopeQuery } from "@/lib/channels";
import { fmt } from "@/lib/i18n";
import type { DemandSignalRow, FeedbackSignalRow, TopicPerformanceRow } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function TopicManager() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  // Scope every channel-owned query to the selected channel (view control;
  // RLS still decides what may be read at all).
  const selection = await getChannelSelection();

  const supabase = await createClient();
  let topics: TopicPerformanceRow[] = [];
  let demand: DemandSignalRow[] = [];
  let signals: FeedbackSignalRow[] = [];
  let dbError = false;

  if (supabase) {
    const [tp, ds, fs] = await Promise.all([
      fetchTopicScores(supabase, selection),
      scopeQuery(supabase.from("demand_signals").select("*"), selection)
        .order("polled_date", { ascending: false })
        .limit(50),
      scopeQuery(supabase.from("feedback_signals").select("*"), selection).order("analyzed_date", { ascending: false }).limit(300),
    ]);
    if (ds.error) dbError = true;
    topics = tp;
    demand = (ds.data as DemandSignalRow[]) ?? [];
    signals = (fs.data as FeedbackSignalRow[]) ?? [];
  }

  // Group feedback signals by topic for the "Why?" explanation (real data).
  const signalsByTopic = new Map<string, FeedbackSignalRow[]>();
  for (const s of signals) {
    if (!s.topic) continue;
    const arr = signalsByTopic.get(s.topic);
    if (arr) arr.push(s);
    else signalsByTopic.set(s.topic, [s]);
  }

  // Say plainly which scores these are. Per-channel verdicts are never merged,
  // so the all-channels view shows the shared table rather than an average.
  const { channels } = await getChannelContext();
  const showSharedNote = selection === ALL_CHANNELS && channels.length > 1;

  const scored = topics.length;
  const strong = topics.filter((tp) => tp.score >= 50).length;
  const topScore = topics.length > 0 ? topics[0].score : null;

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="topics" title={t.topics.title} subtitle={t.topics.subtitle} />

      {showSharedNote && (
        <p className="text-[11px] leading-relaxed text-[var(--color-muted)]">{t.channels.sharedScoresNote}</p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={t.topics.scored} value={<AnimatedNumber value={scored} />} sub={t.topics.scoredSub} />
        <StatCard
          label={t.topics.strong}
          value={<AnimatedNumber value={strong} />}
          tone="ok"
          sub={t.topics.strongSub}
        />
        <StatCard
          label={t.topics.topScore}
          value={topScore === null ? t.common.na : topScore.toFixed(0)}
          tone={topScore !== null && topScore >= 50 ? "ok" : "warn"}
          sub={t.topics.topScoreSub}
        />
      </div>

      <Panel title={t.topics.scores}>
        {dbError ? (
          <EmptyState>{t.topics.readErr}</EmptyState>
        ) : topics.length === 0 ? (
          <EmptyState>{t.topics.empty}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
                  <th className="px-4 py-2 font-semibold">{t.topics.thTopic}</th>
                  <th className="px-4 py-2 text-right font-semibold">{t.topics.thScore}</th>
                  <th className="px-4 py-2 text-right font-semibold">{t.topics.thVideos}</th>
                  <th className="px-4 py-2 text-right font-semibold">{t.topics.thAvgViews}</th>
                  <th className="px-4 py-2 font-semibold">{t.topics.thReason}</th>
                  <th className="px-4 py-2 font-semibold">{t.topics.thUpdated}</th>
                </tr>
              </thead>
              <tbody>
                {topics.map((tp) => (
                  <tr key={tp.topic} className="border-b border-[var(--color-border)]/50 transition-colors hover:bg-[var(--color-panel-2)]">
                    <td className="px-4 py-2 text-[var(--color-fg)]">{tp.topic}</td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <ExplainScore score={tp.score} reason={tp.reason} signals={signalsByTopic.get(tp.topic) ?? []} />
                        <span
                          className="mono font-bold tabular-nums"
                          style={{ color: tp.score >= 50 ? "var(--color-ok)" : "var(--color-warn)" }}
                        >
                          {tp.score.toFixed(0)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right mono tabular-nums text-[var(--color-muted)]">
                      {num(tp.videos_analyzed)}
                    </td>
                    <td className="px-4 py-2 text-right mono tabular-nums text-[var(--color-muted)]">
                      {decimal(tp.avg_views_per_day)}
                    </td>
                    <td className="px-4 py-2 max-w-xs truncate text-[var(--color-muted)]">
                      {tp.reason ?? t.common.na}
                    </td>
                    <td className="px-4 py-2 mono text-[11px] text-[var(--color-muted)]">
                      {relativeTime(tp.updated_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={t.topics.demand}>
        {demand.length === 0 ? (
          <EmptyState>{t.topics.noDemand}</EmptyState>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {demand.map((d) => (
              <li
                key={d.id}
                className="row-sweep flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--color-panel-2)]"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-[var(--color-fg)]">{d.topic_phrase}</div>
                  <div className="mono text-[10px] text-[var(--color-muted)]">
                    {fmt(t.topics.polled, { t: relativeTime(d.polled_date) })}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="mono text-lg font-bold tabular-nums text-[var(--color-primary)]">
                    {num(d.mention_count)}
                  </div>
                  <div className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
                    {t.topics.mentions}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
