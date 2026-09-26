import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { StatCard, Panel, EmptyState } from "@/components/ui";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelScope } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import { fmt } from "@/lib/i18n";
import type { SystemEventRow } from "@/lib/types";
import { ErrorTable } from "@/components/errors/ErrorTable";
import { statusTone, storedMs } from "@/lib/format";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_LIMIT = 300;

/** A failure is anything whose status tone is "fail", or whose event name ends
 *  in `.failed` (upload.failed, agent.failed, job.failed, …). */
function isFailure(e: SystemEventRow): boolean {
  return statusTone(e.status) === "fail" || e.event.endsWith(".failed");
}

export default async function ErrorCenter() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  // Scope channel-owned queries to the selected channel (view control;
  // RLS still decides what may be read at all).
  const scope = await getChannelScope();

  const supabase = await createClient();
  let events: SystemEventRow[] = [];
  let queryFailed = false;

  if (supabase) {
    const { data, error } = await scopeQuery(
        supabase.from("system_events").select("*"),
        scope, { nullIsGlobal: true },
      )
      .order("ts", { ascending: false })
      .limit(FETCH_LIMIT);
    if (error) queryFailed = true;
    events = (data as SystemEventRow[]) ?? [];
  }

  const errors = events.filter(isFailure);
  const errors24h = errors.filter(
    (e) => Date.now() - (storedMs(e.ts) ?? 0) < DAY_MS,
  ).length;
  const lastError = errors[0]?.ts ?? null;

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="errors" title={t.errors.title} subtitle={t.errors.subtitle} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label={t.errors.errors24h}
          value={<AnimatedNumber value={errors24h} />}
          tone={errors24h ? "fail" : "ok"}
          sub={errors24h ? t.errors.needsAttention : t.errors.none}
        />
        <StatCard
          label={t.errors.errorsShown}
          value={<AnimatedNumber value={errors.length} />}
          tone={errors.length ? "warn" : "ok"}
          sub={fmt(t.errors.ofRecent, { n: events.length })}
        />
        <StatCard
          label={t.errors.scanned}
          value={<AnimatedNumber value={events.length} />}
          sub={fmt(t.errors.mostRecent, { n: FETCH_LIMIT })}
        />
        <StatCard
          label={t.errors.lastError}
          value={lastError ? t.errors.seen : t.errors.noneUpper}
          tone={lastError ? "warn" : "ok"}
          sub={lastError ? t.errors.seeTable : t.errors.cleanWindow}
        />
      </div>

      <Panel title={t.errors.failureEvents}>
        {queryFailed ? (
          <EmptyState>{t.errors.readErr}</EmptyState>
        ) : (
          <ErrorTable rows={errors} />
        )}
      </Panel>
    </div>
  );
}
