import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { AutonomyView } from "@/components/autonomy/AutonomyView";
import { OperationsPanels } from "@/components/autonomy/OperationsPanels";
import {
  autonomousActions,
  autonomyHealth,
  autonomyPosture,
  duplicateTopics,
  failureLearning,
  publishingWindow,
} from "@/lib/autonomy";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelSelection } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import type {
  ContentQueueRow,
  MetricsSnapshotRow,
  PipelineRunRow,
  SystemEventRow,
  VideoRow,
} from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AutonomyPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  // Scope every channel-owned query to the selected channel (view control;
  // RLS still decides what may be read at all).
  const selection = await getChannelSelection();

  const supabase = await createClient();
  let events: SystemEventRow[] = [];
  let videos: VideoRow[] = [];
  let snapshots: MetricsSnapshotRow[] = [];
  let queue: ContentQueueRow[] = [];
  let runs: PipelineRunRow[] = [];
  // The two operational tables are added by the updated schema.sql; until it
  // is applied the query errors and we say so instead of showing an empty list.
  let tablesMissing = false;

  if (supabase) {
    const [ev, vid, snap, q, r] = await Promise.all([
      scopeQuery(supabase.from("system_events").select("*"), selection, { nullIsGlobal: true }).order("ts", { ascending: false }).limit(500),
      scopeQuery(supabase.from("videos").select("*"), selection).order("published_at", { ascending: false }).limit(500),
      supabase.from("metrics_snapshots").select("*").order("snapshot_date", { ascending: false }).limit(2000),
      scopeQuery(supabase.from("content_queue").select("*"), selection).order("added_at", { ascending: false }).limit(200),
      scopeQuery(supabase.from("pipeline_runs").select("*"), selection).order("updated_at", { ascending: false }).limit(200),
    ]);
    events = (ev.data as SystemEventRow[]) ?? [];
    videos = (vid.data as VideoRow[]) ?? [];
    snapshots = (snap.data as MetricsSnapshotRow[]) ?? [];
    tablesMissing = Boolean(q.error || r.error);
    queue = (q.data as ContentQueueRow[]) ?? [];
    runs = (r.data as PipelineRunRow[]) ?? [];
  }

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="autonomy" title={t.auto.title} subtitle={t.auto.subtitle} />
      <OperationsPanels queue={queue} runs={runs} tablesMissing={tablesMissing} />
      <AutonomyView
        posture={autonomyPosture(events)}
        health={autonomyHealth(events)}
        actions={autonomousActions(events, 100)}
        failures={failureLearning(events)}
        window={publishingWindow(videos, snapshots)}
        duplicates={duplicateTopics(videos)}
      />
    </div>
  );
}
