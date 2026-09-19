import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { MemoryView } from "@/components/intel/MemoryView";
import { deriveMemories, deriveOpportunities } from "@/lib/memory";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { fetchTopicScores, getChannelSelection } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import type { DemandSignalRow, FeedbackSignalRow, TopicPerformanceRow } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function MemoryPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  // Scope every channel-owned query to the selected channel (view control;
  // RLS still decides what may be read at all).
  const selection = await getChannelSelection();

  const supabase = await createClient();
  let topicPerf: TopicPerformanceRow[] = [];
  let signals: FeedbackSignalRow[] = [];
  let demand: DemandSignalRow[] = [];

  if (supabase) {
    const [tp, fs, ds] = await Promise.all([
      fetchTopicScores(supabase, selection),
      scopeQuery(supabase.from("feedback_signals").select("*"), selection).order("analyzed_date", { ascending: false }).limit(300),
      scopeQuery(supabase.from("demand_signals").select("*"), selection).order("polled_date", { ascending: false }).limit(100),
    ]);
    topicPerf = tp;
    signals = (fs.data as FeedbackSignalRow[]) ?? [];
    demand = (ds.data as DemandSignalRow[]) ?? [];
  }

  const memories = deriveMemories(topicPerf, signals);
  const opportunities = deriveOpportunities(topicPerf, demand);

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="memory" title={t.intel.memoryTitle} subtitle={t.intel.memorySubtitle} />
      <MemoryView memories={memories} opportunities={opportunities} />
    </div>
  );
}
