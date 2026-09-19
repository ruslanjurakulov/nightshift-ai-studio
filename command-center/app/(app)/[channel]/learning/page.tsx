import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { LearningView } from "@/components/intel/LearningView";
import { toDecisionSignal, type DecisionSignal } from "@/lib/decisions";
import { deriveTopicIntel } from "@/lib/memory";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { fetchTopicScores, getChannelSelection } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import type { FeedbackSignalRow, TopicPerformanceRow, VideoRow } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function LearningPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  // Scope every channel-owned query to the selected channel (view control;
  // RLS still decides what may be read at all).
  const selection = await getChannelSelection();

  const supabase = await createClient();
  let signals: FeedbackSignalRow[] = [];
  let topicPerf: TopicPerformanceRow[] = [];
  let videos: VideoRow[] = [];

  if (supabase) {
    const [fs, tp, vid] = await Promise.all([
      scopeQuery(supabase.from("feedback_signals").select("*"), selection).order("analyzed_date", { ascending: false }).limit(300),
      fetchTopicScores(supabase, selection),
      scopeQuery(supabase.from("videos").select("*"), selection).order("published_at", { ascending: false }).limit(200),
    ]);
    signals = (fs.data as FeedbackSignalRow[]) ?? [];
    topicPerf = tp;
    videos = (vid.data as VideoRow[]) ?? [];
  }

  const decisionSignals = signals
    .map(toDecisionSignal)
    .filter((s): s is DecisionSignal => s !== null);
  const topics = deriveTopicIntel(topicPerf, signals, videos);

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="learning" title={t.intel.learningTitle} subtitle={t.intel.learningSubtitle} />
      <LearningView signals={decisionSignals} topics={topics} />
    </div>
  );
}
