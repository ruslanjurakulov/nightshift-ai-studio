import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { LearningView } from "@/components/intel/LearningView";
import { LearningsPanel } from "@/components/intel/LearningsPanel";
import { resolveRole, atLeast } from "@/lib/auth/roles";
import { isMissingTable, type LearningRow } from "@/lib/learnings";
import { toDecisionSignal, type DecisionSignal } from "@/lib/decisions";
import { deriveTopicIntel } from "@/lib/memory";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { fetchTopicScores, getChannelSelection } from "@/lib/channels-server";
import { isScoped, scopeQuery } from "@/lib/channels";
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
  let learnings: LearningRow[] = [];
  let learningsMissing = false;

  if (supabase) {
    const [fs, tp, vid, lr] = await Promise.all([
      scopeQuery(supabase.from("feedback_signals").select("*"), selection).order("analyzed_date", { ascending: false }).limit(300),
      fetchTopicScores(supabase, selection),
      scopeQuery(supabase.from("videos").select("*"), selection).order("published_at", { ascending: false }).limit(200),
      // Proposed/approved learnings (migration 0014). A missing table degrades
      // to a notice, not a broken page.
      scopeQuery(supabase.from("learnings").select("*"), selection).order("created_at", { ascending: false }).limit(300),
    ]);
    signals = (fs.data as FeedbackSignalRow[]) ?? [];
    topicPerf = tp;
    videos = (vid.data as VideoRow[]) ?? [];
    learnings = (lr.data as LearningRow[]) ?? [];
    learningsMissing = isMissingTable(lr.error);
  }
  // Presentation only — /api/learnings/decide re-checks the role, and RLS
  // checks it again.
  const canDecide = atLeast(await resolveRole(), "admin");

  const decisionSignals = signals
    .map(toDecisionSignal)
    .filter((s): s is DecisionSignal => s !== null);
  const topics = deriveTopicIntel(topicPerf, signals, videos);

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="learning" title={t.intel.learningTitle} subtitle={t.intel.learningSubtitle} />
      <LearningsPanel
        rows={learnings}
        canDecide={canDecide}
        showChannel={!isScoped(selection)}
        migrationMissing={learningsMissing}
      />
      <LearningView signals={decisionSignals} topics={topics} />
    </div>
  );
}
