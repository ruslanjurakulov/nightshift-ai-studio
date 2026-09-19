import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { IntelligenceMap } from "@/components/intelligence/IntelligenceMap";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelSelection } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import type { SystemEventRow } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function IntelligencePage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  // Scope channel-owned queries to the selected channel (view control;
  // RLS still decides what may be read at all).
  const selection = await getChannelSelection();

  const supabase = await createClient();
  let events: SystemEventRow[] = [];
  if (supabase) {
    const { data } = await scopeQuery(
        supabase.from("system_events").select("*"),
        selection, { nullIsGlobal: true },
      )
      .order("ts", { ascending: false })
      .limit(500);
    events = (data as SystemEventRow[]) ?? [];
  }

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="intelligence" title={t.ops.intelTitle} subtitle={t.ops.intelSubtitle} />

      <IntelligenceMap initial={events} selection={selection} />
    </div>
  );
}
