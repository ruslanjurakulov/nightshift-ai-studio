import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Panel, EmptyState, StatCard } from "@/components/ui";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";
import { DataList } from "@/components/g4/DataList";
import { Figures } from "@/components/g4/Section";
import "../../app-pages-g4.css";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { relativeTime } from "@/lib/format";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { fetchTopicScores, getChannelScope } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import { fmt } from "@/lib/i18n";
import type { FeedbackSignalRow, TopicPerformanceRow } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function signalTone(signal: string): LampTone {
  if (signal.startsWith("HIGH_")) return "ok";
  if (signal.startsWith("LOW_")) return "fail";
  return "idle";
}

export default async function FeedbackPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t, locale } = await getDictionary();
  // Scope every channel-owned query to the selected channel (view control;
  // RLS still decides what may be read at all).
  const scope = await getChannelScope();

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
      scopeQuery(supabase.from("feedback_signals").select("*"), scope).order("analyzed_date", { ascending: false }).limit(200),
      fetchTopicScores(supabase, scope, 50),
    ]);
    signals = (sg.data as FeedbackSignalRow[]) ?? [];
    topics = tp;
  }

  const lastRun = signals[0]?.analyzed_date ?? null;

  return (
    <div className="rhythm ns-open g4 stagger-enter">
      <PageHeader icon="feedback" title={t.feedback.title} subtitle={t.feedback.subtitle} />

      {/* The loop, drawn from the real stages the backend runs: the page's desk. */}
      <section className="ns-desk" aria-label={t.feedback.title}>
        <ol className="g4-loop">
          {LOOP.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      <Figures>
        <StatCard label={t.feedback.scoredTopics} value={<AnimatedNumber value={topics.length} />} />
        <StatCard label={t.feedback.signalsRecorded} value={<AnimatedNumber value={signals.length} />} sub={t.feedback.mostRecent} />
        <StatCard label={t.feedback.lastAnalysis} value={lastRun ? relativeTime(lastRun, locale) : t.common.dash} sub={lastRun ?? t.feedback.notRun} />
        <StatCard
          label={t.feedback.aboveAvg}
          value={<AnimatedNumber value={topics.filter((tp) => tp.score >= 50).length} />}
          tone="ok"
          sub={fmt(t.feedback.ofTopics, { n: topics.length })}
        />
      </Figures>

      <Panel title={t.feedback.learned}>
        {topics.length === 0 ? (
          <EmptyState>{t.feedback.emptyLearned}</EmptyState>
        ) : (
          <DataList
            caption={t.feedback.learned}
            rows={topics}
            rowKey={(tp) => tp.topic}
            columns={[
              { key: "topic", label: t.feedback.thTopic, render: (tp) => tp.topic },
              {
                key: "score",
                label: t.feedback.thScore,
                render: (tp) => (
                  <span className="font-semibold tnum" style={{ color: tp.score >= 50 ? "var(--color-ok)" : "var(--color-warn)" }}>
                    {tp.score.toFixed(0)}
                  </span>
                ),
              },
              { key: "videos", label: t.feedback.thVideos, render: (tp) => <span className="g4-muted tnum">{tp.videos_analyzed}</span> },
              { key: "reason", label: t.feedback.thReason, render: (tp) => <span className="g4-muted">{tp.reason ?? t.common.dash}</span> },
              { key: "updated", label: t.feedback.thUpdated, nowrap: true, render: (tp) => <span className="g4-muted tnum">{relativeTime(tp.updated_at, locale)}</span> },
            ]}
          />
        )}
      </Panel>

      <Panel title={t.feedback.recentSignals}>
        {signals.length === 0 ? (
          <EmptyState>{t.feedback.noSignals}</EmptyState>
        ) : (
          <DataList
            caption={t.feedback.recentSignals}
            rows={signals}
            rowKey={(sg, i) => `${sg.video_id}-${sg.signal}-${i}`}
            columns={[
              { key: "signal", label: t.feedback.sgSignal, render: (sg) => <StatusLamp tone={signalTone(sg.signal)} label={sg.signal} /> },
              { key: "topic", label: t.feedback.sgTopic, render: (sg) => <span className="g4-muted">{sg.topic ?? t.common.dash}</span> },
              { key: "video", label: t.feedback.sgVideo, render: (sg) => <span className="mono g4-muted g4-small">{sg.video_id}</span> },
              { key: "detail", label: t.feedback.sgDetail, render: (sg) => <span className="g4-muted">{sg.detail ?? t.common.dash}</span> },
              { key: "at", label: t.feedback.sgAnalyzed, nowrap: true, render: (sg) => <span className="g4-muted tnum">{relativeTime(sg.analyzed_date, locale)}</span> },
            ]}
          />
        )}
      </Panel>
    </div>
  );
}
