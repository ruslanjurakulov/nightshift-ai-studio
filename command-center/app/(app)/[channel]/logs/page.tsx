import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Panel, EmptyState } from "@/components/ui";
import { LogViewer } from "@/components/logs/LogViewer";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelScope } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import { fmt } from "@/lib/i18n";
import type { SystemEventRow } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const LIMIT = 300;

export default async function LogsPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  // Scope channel-owned queries to the selected channel (view control;
  // RLS still decides what may be read at all).
  const scope = await getChannelScope();

  const supabase = await createClient();
  let rows: SystemEventRow[] = [];
  if (supabase) {
    const { data } = await scopeQuery(
        supabase.from("system_events").select("*"),
        scope, { nullIsGlobal: true },
      )
      .order("ts", { ascending: false })
      .limit(LIMIT);
    rows = (data as SystemEventRow[]) ?? [];
  }

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="logs" title={t.logs.title} subtitle={fmt(t.logs.subtitle, { n: LIMIT })} />
      <Panel title={t.logs.eventLog}>
        {rows.length === 0 ? (
          <EmptyState>{t.logs.empty}</EmptyState>
        ) : (
          <div className="h-[560px]">
            <LogViewer rows={rows} />
          </div>
        )}
      </Panel>
    </div>
  );
}
