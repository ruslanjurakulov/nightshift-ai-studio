import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { TimeMachine } from "@/components/timemachine/TimeMachine";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelSelection } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import type { SystemEventRow } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export default async function TimeMachinePage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  // Scope channel-owned queries to the selected channel (view control;
  // RLS still decides what may be read at all).
  const selection = await getChannelSelection();

  const supabase = await createClient();
  let events: SystemEventRow[] = [];
  if (supabase) {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const { data } = await scopeQuery(
        supabase.from("system_events").select("*"),
        selection, { nullIsGlobal: true },
      )
      .gte("ts", since)
      .order("ts", { ascending: false })
      .limit(1000);
    events = (data as SystemEventRow[]) ?? [];
  }

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="timeMachine" title={t.ops.timeMachineTitle} subtitle={t.ops.timeMachineSubtitle} />
      <TimeMachine initial={events} />
    </div>
  );
}
