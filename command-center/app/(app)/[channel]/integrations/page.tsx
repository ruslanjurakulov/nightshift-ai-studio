import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import "../../app-pages-g2.css";
import { getChannelScope } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import { fmt, type Dictionary } from "@/lib/i18n";
import type { SystemEventRow } from "@/lib/types";
import { relativeTime, storedMs } from "@/lib/format";
import { WorkerStatusPanel } from "@/components/workers/WorkerStatusPanel";
import { WORKER_COLUMNS, coerceWorkers, isMissingWorkerTable, type WorkerRow } from "@/lib/workers";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const RECENT_MS = 3 * 24 * 60 * 60 * 1000; // "recent" = last 3 days

type DetailKey = keyof Dictionary["integrations"];

interface Health {
  name: string;
  detailKey: DetailKey;
  tone: "ok" | "warn" | "fail" | "idle";
  status: string;
  lastSuccess: string | null;
}

/** Latest ts among events whose `event` matches any of `names`, optionally only failures. */
function latest(events: SystemEventRow[], names: string[], failedOnly = false): string | null {
  const hit = events.find(
    (e) => names.some((n) => e.event === n) && (!failedOnly || (e.status ?? "").toLowerCase() === "failed"),
  );
  return hit?.ts ?? null;
}

function derive(
  name: string,
  ok: string[],
  fail: string[],
  events: SystemEventRow[],
  t: Dictionary,
): Health {
  const lastOk = latest(events, ok);
  const lastFail = latest(events, fail, true);
  const recent = lastOk && Date.now() - (storedMs(lastOk) ?? 0) < RECENT_MS;
  if (recent) return { name, detailKey: "recentSuccess", tone: "ok", status: t.status.healthy, lastSuccess: lastOk };
  if (lastFail) return { name, detailKey: "recentFailures", tone: "warn", status: t.status.degraded, lastSuccess: lastOk };
  if (lastOk) return { name, detailKey: "stale", tone: "idle", status: t.status.unknown, lastSuccess: lastOk };
  return { name, detailKey: "noActivity", tone: "idle", status: t.status.unknown, lastSuccess: null };
}

export default async function IntegrationsPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  // Scope channel-owned queries to the selected channel (view control;
  // RLS still decides what may be read at all).
  const scope = await getChannelScope();

  const supabase = await createClient();
  let events: SystemEventRow[] = [];
  let dbOk = false;
  // The workers' own reports (0045): not channel-owned, platform admins only by RLS.
  let workers: WorkerRow[] = [];
  let workersRead: "ok" | "missing" | "failed" = "failed";
  if (supabase) {
    const [ev, wk] = await Promise.all([
      scopeQuery(supabase.from("system_events").select("*"), scope, { nullIsGlobal: true })
        .order("ts", { ascending: false })
        .limit(1000),
      supabase.from("worker_status").select(WORKER_COLUMNS).order("updated_at", { ascending: false }).limit(50),
    ]);
    dbOk = !ev.error;
    events = (ev.data as SystemEventRow[]) ?? [];
    if (!wk.error) {
      workersRead = "ok";
      workers = coerceWorkers(wk.data);
    } else if (isMissingWorkerTable(wk.error)) {
      workersRead = "missing";
    }
  }

  const items: Health[] = [
    {
      name: t.integrations.supabase,
      detailKey: dbOk ? "querySucceeded" : "queryFailed",
      tone: dbOk ? "ok" : "fail",
      status: dbOk ? t.status.healthy : t.status.offline,
      lastSuccess: dbOk ? new Date().toISOString() : null,
    },
    derive(t.integrations.youtube, ["upload.completed", "video.published"], ["upload.failed"], events, t),
    derive(t.integrations.gemini, ["script.completed", "topic.selected"], ["agent.failed"], events, t),
    derive(t.integrations.intelPoll, ["system.heartbeat"], [], events, t),
    derive(t.integrations.feedbackLoop, ["feedback.generated", "feedback.applied"], [], events, t),
  ];

  return (
    <div className="rhythm ns-open stagger-enter">
      <PageHeader icon="integrations" title={t.integrations.title} subtitle={t.integrations.subtitle} />

      <section className="ns-desk g2-desk" aria-label={t.integrations.title}>
        <ul className="g2-rows" style={{ borderTop: 0 }}>
          {items.map((h, i) => (
            <li key={h.name} className="g2-row g2-row-status" style={i === 0 ? { paddingTop: 0 } : undefined}>
              <div className="g2-row-main">
                <h2 className="g2-strong">{h.name}</h2>
                <p className="g2-note tnum mt-1">{t.integrations[h.detailKey]}</p>
              </div>
              <p className="g2-note tnum g2-last">
                {fmt(t.integrations.lastSuccess, { t: h.lastSuccess ? relativeTime(h.lastSuccess) : t.common.na })}
              </p>
              <StatusLamp tone={h.tone} label={h.status} live={h.tone === "ok"} />
            </li>
          ))}
        </ul>
      </section>

      <WorkerStatusPanel read={workersRead} rows={workers} nowMs={Date.now()} />

      <section className="g2-section" aria-labelledby="measured-title">
        <h2 id="measured-title" className="g2-h2">{t.integrations.measuredTitle}</h2>
        <p className="g2-note">{t.integrations.measuredBody}</p>
      </section>
    </div>
  );
}
