import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { EmptyState } from "@/components/ui";
import { Figures } from "@/components/g2/Figures";
import "../../app-pages-g2.css";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { ExplainScore } from "@/components/topics/ExplainScore";
import { num, decimal, relativeTime } from "@/lib/format";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { fetchTopicScores, getChannelContext, getChannelScope } from "@/lib/channels-server";
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
  const scope = await getChannelScope();
  const { selection } = scope;

  const supabase = await createClient();
  let topics: TopicPerformanceRow[] = [];
  let demand: DemandSignalRow[] = [];
  let signals: FeedbackSignalRow[] = [];
  let dbError = false;

  if (supabase) {
    const [tp, ds, fs] = await Promise.all([
      fetchTopicScores(supabase, scope),
      scopeQuery(supabase.from("demand_signals").select("*"), scope)
        .order("polled_date", { ascending: false })
        .limit(50),
      scopeQuery(supabase.from("feedback_signals").select("*"), scope).order("analyzed_date", { ascending: false }).limit(300),
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
    <div className="rhythm ns-open stagger-enter">
      <PageHeader icon="topics" title={t.topics.title} subtitle={t.topics.subtitle} />

      {showSharedNote && <p className="g2-note">{t.channels.sharedScoresNote}</p>}

      <Figures
        items={[
          { label: t.topics.scored, value: <AnimatedNumber value={scored} />, sub: t.topics.scoredSub },
          { label: t.topics.strong, value: <AnimatedNumber value={strong} />, tone: "ok", sub: t.topics.strongSub },
          {
            label: t.topics.topScore,
            value: topScore === null ? t.common.na : topScore.toFixed(0),
            tone: topScore !== null && topScore >= 50 ? "ok" : "warn",
            sub: t.topics.topScoreSub,
          },
        ]}
      />

      <section className="ns-desk g2-desk" aria-labelledby="topics-scores-title">
        <div className="g2-stack-lg">
          <h2 id="topics-scores-title" className="g2-h2">
            {t.topics.scores}
          </h2>
          {dbError ? (
            <EmptyState>{t.topics.readErr}</EmptyState>
          ) : topics.length === 0 ? (
            <EmptyState>{t.topics.empty}</EmptyState>
          ) : (
            <table className="g2-ledger g2-ledger-wide">
              <thead>
                <tr>
                  <th scope="col">{t.topics.thTopic}</th>
                  <th scope="col" className="num">{t.topics.thScore}</th>
                  <th scope="col" className="num">{t.topics.thVideos}</th>
                  <th scope="col" className="num">{t.topics.thAvgViews}</th>
                  <th scope="col">{t.topics.thReason}</th>
                  <th scope="col">{t.topics.thUpdated}</th>
                </tr>
              </thead>
              <tbody>
                {topics.map((tp) => (
                  <tr key={tp.topic}>
                    <td className="font-semibold text-[var(--color-fg)]">{tp.topic}</td>
                    <td data-label={t.topics.thScore} data-wide className="num">
                      <div className="g2-score">
                        <span className="g2-bar" aria-hidden>
                          <span style={{ width: `${Math.max(0, Math.min(100, tp.score))}%` }} data-strong={tp.score >= 50 ? "true" : undefined} />
                        </span>
                        <span
                          className="tnum font-semibold tabular-nums"
                          style={{ color: tp.score >= 50 ? "var(--color-ok)" : "var(--color-warn)" }}
                        >
                          {tp.score.toFixed(0)}
                        </span>
                        <ExplainScore score={tp.score} reason={tp.reason} signals={signalsByTopic.get(tp.topic) ?? []} />
                      </div>
                    </td>
                    <td data-label={t.topics.thVideos} className="num dim">{num(tp.videos_analyzed)}</td>
                    <td data-label={t.topics.thAvgViews} className="num dim">{decimal(tp.avg_views_per_day)}</td>
                    <td data-label={t.topics.thReason} data-wide className="dim g2-reason">
                      {tp.reason ?? t.common.na}
                    </td>
                    <td data-label={t.topics.thUpdated} className="dim">{relativeTime(tp.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="g2-section" aria-labelledby="topics-demand-title">
        <h2 id="topics-demand-title" className="g2-h2">
          {t.topics.demand}
        </h2>
        {demand.length === 0 ? (
          <EmptyState>{t.topics.noDemand}</EmptyState>
        ) : (
          <ul className="g2-rows">
            {demand.map((d) => (
              <li key={d.id} className="g2-row g2-row-count">
                <div className="g2-row-main">
                  <div className="g2-strong">{d.topic_phrase}</div>
                  <div className="g2-note tnum">{fmt(t.topics.polled, { t: relativeTime(d.polled_date) })}</div>
                </div>
                <div className="g2-count">
                  <div className="tnum">{num(d.mention_count)}</div>
                  <div className="g2-label">{t.topics.mentions}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
