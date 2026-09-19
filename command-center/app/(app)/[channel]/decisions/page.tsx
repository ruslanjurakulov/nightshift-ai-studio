import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Panel, EmptyState } from "@/components/ui";
import { DecisionList } from "@/components/intel/DecisionList";
import { deriveDecisions, scoreLineage, type LineageRow } from "@/lib/decisions";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { fetchTopicScores, getChannelSelection } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import type { FeedbackSignalRow, SystemEventRow, TopicPerformanceRow } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function DecisionsPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  // Scope every channel-owned query to the selected channel (view control;
  // RLS still decides what may be read at all).
  const selection = await getChannelSelection();

  const supabase = await createClient();
  let events: SystemEventRow[] = [];
  let topicPerf: TopicPerformanceRow[] = [];
  let signals: FeedbackSignalRow[] = [];

  if (supabase) {
    const [ev, tp, fs] = await Promise.all([
      scopeQuery(supabase.from("system_events").select("*"), selection, { nullIsGlobal: true }).order("ts", { ascending: false }).limit(500),
      fetchTopicScores(supabase, selection),
      scopeQuery(supabase.from("feedback_signals").select("*"), selection).order("analyzed_date", { ascending: false }).limit(300),
    ]);
    events = (ev.data as SystemEventRow[]) ?? [];
    topicPerf = tp;
    signals = (fs.data as FeedbackSignalRow[]) ?? [];
  }

  const decisions = deriveDecisions(events, topicPerf, signals);

  // Lineage per topic — where each score actually came from.
  const signalCountByTopic = new Map<string, number>();
  for (const s of signals) {
    if (!s.topic) continue;
    signalCountByTopic.set(s.topic, (signalCountByTopic.get(s.topic) ?? 0) + 1);
  }
  const lineage: Record<string, LineageRow[]> = {};
  for (const p of topicPerf) {
    lineage[p.topic] = scoreLineage(p, signalCountByTopic.get(p.topic) ?? 0);
  }

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="decisions" title={t.intel.decisionsTitle} subtitle={t.intel.decisionsSubtitle} />

      <Panel title={t.intel.decisionsTitle}>
        {decisions.length === 0 ? (
          <EmptyState>{t.intel.noDecisions}</EmptyState>
        ) : (
          <DecisionList decisions={decisions} lineage={lineage} />
        )}
      </Panel>
    </div>
  );
}
