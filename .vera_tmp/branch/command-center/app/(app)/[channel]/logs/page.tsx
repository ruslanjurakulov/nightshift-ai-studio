import { createClient } from "@/lib/supabase/server";
import { ErrorState } from "@/components/ReadError";
import { readFailed } from "@/lib/readState";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Panel, EmptyState } from "@/components/ui";
import { Section } from "@/components/g4/Section";
import "../../app-pages-g4.css";
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
  let failed = false;
  if (supabase) {
    const res = await scopeQuery(
        supabase.from("system_events").select("*"),
        scope, { nullIsGlobal: true },
      )
      .order("ts", { ascending: false })
      .limit(LIMIT);
    failed = readFailed(res);
    rows = (res.data as SystemEventRow[]) ?? [];
  }

  return (
    <div className="rhythm ns-open g4 stagger-enter">
      <PageHeader icon="logs" title={t.logs.title} subtitle={fmt(t.logs.subtitle, { n: LIMIT })} />
      {failed ? (
        <Panel title={t.logs.eventLog}>
          <ErrorState />
        </Panel>
      ) : rows.length === 0 ? (
        <Panel title={t.logs.eventLog}>
          <EmptyState>{t.logs.empty}</EmptyState>
        </Panel>
      ) : (
        <Section desk title={t.logs.eventLog}>
          <div className="h-[34rem] sm:h-[560px]">
            <LogViewer rows={rows} />
          </div>
        </Section>
      )}
    </div>
  );
}
