import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Panel, StatusPill } from "@/components/ui";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelScope } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import { fmt, type Dictionary } from "@/lib/i18n";
import type { SystemEventRow } from "@/lib/types";
import { relativeTime, storedMs } from "@/lib/format";

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
  if (supabase) {
    const { data, error } = await scopeQuery(
        supabase.from("system_events").select("*"),
        scope, { nullIsGlobal: true },
      )
      .order("ts", { ascending: false })
      .limit(1000);
    dbOk = !error;
    events = (data as SystemEventRow[]) ?? [];
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
    <div className="rhythm stagger-enter">
      <PageHeader icon="integrations" title={t.integrations.title} subtitle={t.integrations.subtitle} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((h) => (
          <div key={h.name} className="panel p-4 transition-transform duration-200 hover:-translate-y-0.5 hover:border-[var(--color-primary-dim)]">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-[var(--color-fg)]">{h.name}</span>
              <StatusPill tone={h.tone} label={h.status} live={h.tone === "ok"} />
            </div>
            <p className="mt-1.5 mono text-[11px] text-[var(--color-muted)]">{t.integrations[h.detailKey]}</p>
            <p className="mt-0.5 mono text-[11px] text-[var(--color-muted)]">
              {fmt(t.integrations.lastSuccess, { t: h.lastSuccess ? relativeTime(h.lastSuccess) : t.common.na })}
            </p>
          </div>
        ))}
      </div>

      <Panel title={t.integrations.measuredTitle}>
        <div className="p-4 text-[11px] leading-relaxed text-[var(--color-muted)]">
          {t.integrations.measuredBody}
        </div>
      </Panel>
    </div>
  );
}
