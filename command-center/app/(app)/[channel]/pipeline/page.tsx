import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Panel, EmptyState, StatusPill } from "@/components/ui";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelScope } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import { fmt, type Dictionary } from "@/lib/i18n";
import type { SystemEventRow } from "@/lib/types";
import { StageStrip, StageLegend, type StageState, type StageView } from "@/components/pipeline/StageStrip";
import { relativeTime, statusTone, storedMs, timeOfDay } from "@/lib/format";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type StageLabelKey = keyof Dictionary["pipeline"];

/**
 * The canonical pipeline stages in order. `completed` is the exact event that
 * marks a stage done; `base` is the token whose `.started` / `.failed` variants
 * signal in-progress / error for that same stage. `labelKey` selects the
 * localized display name (event tokens themselves are never translated).
 */
const STAGES: { key: string; labelKey: StageLabelKey; completed: string; base: string }[] = [
  { key: "topic", labelKey: "sTopic", completed: "topic.selected", base: "topic" },
  { key: "research", labelKey: "sResearch", completed: "research.completed", base: "research" },
  { key: "script", labelKey: "sScript", completed: "script.completed", base: "script" },
  { key: "voice", labelKey: "sVoice", completed: "voice.completed", base: "voice" },
  { key: "media", labelKey: "sMedia", completed: "media.completed", base: "media" },
  { key: "thumbnail", labelKey: "sThumbnail", completed: "thumbnail.completed", base: "thumbnail" },
  { key: "render", labelKey: "sRender", completed: "render.completed", base: "render" },
  { key: "upload", labelKey: "sUpload", completed: "upload.completed", base: "upload" },
  { key: "publish", labelKey: "sPublish", completed: "video.published", base: "video" },
];

const HEARTBEAT_MS = 30 * 60 * 1000;

function stageStatus(events: SystemEventRow[], stage: (typeof STAGES)[number]): { state: StageState; ts: string | null } {
  const rel = events.filter(
    (e) => e.event === stage.completed || e.event.startsWith(stage.base + "."),
  );
  if (rel.length === 0) return { state: "WAITING", ts: null };

  const completed = rel.find((e) => e.event === stage.completed || statusTone(e.status) === "ok");
  if (completed) return { state: "COMPLETED", ts: completed.ts };

  const failed = rel.find((e) => e.event.endsWith(".failed") || statusTone(e.status) === "fail");
  if (failed) return { state: "FAILED", ts: failed.ts };

  const running = rel.find((e) => e.event.endsWith(".started") || statusTone(e.status) === "run");
  if (running) return { state: "RUNNING", ts: running.ts };

  return { state: "RUNNING", ts: rel[0].ts };
}

type Overall = "RUNNING" | "COMPLETED" | "FAILED" | "IN PROGRESS";
interface VideoPipeline {
  videoId: string;
  stages: StageView[];
  lastActivity: string | null;
  overall: Overall;
}

function derivePipelines(events: SystemEventRow[], label: (k: StageLabelKey) => string): VideoPipeline[] {
  const byVideo = new Map<string, SystemEventRow[]>();
  for (const e of events) {
    if (!e.video_id) continue;
    const list = byVideo.get(e.video_id);
    if (list) list.push(e);
    else byVideo.set(e.video_id, [e]);
  }

  const pipelines: VideoPipeline[] = [];
  for (const [videoId, rows] of byVideo) {
    const stages = STAGES.map<StageView>((s) => {
      const st = stageStatus(rows, s);
      return { key: s.key, label: label(s.labelKey), state: st.state, ts: st.ts };
    });
    const lastActivity = rows[0]?.ts ?? null;
    const anyFailed = stages.some((s) => s.state === "FAILED");
    const anyRunning = stages.some((s) => s.state === "RUNNING");
    const published = stages[stages.length - 1].state === "COMPLETED";
    const overall: Overall = anyFailed
      ? "FAILED"
      : anyRunning
        ? "RUNNING"
        : published
          ? "COMPLETED"
          : "IN PROGRESS";
    pipelines.push({ videoId, stages, lastActivity, overall });
  }

  // Most recently active videos first.
  return pipelines.sort(
    (a, b) => new Date(b.lastActivity ?? 0).getTime() - new Date(a.lastActivity ?? 0).getTime(),
  );
}

interface SystemPass {
  event: string;
  agent: string | null;
  count: number;
  lastTs: string;
  tone: ReturnType<typeof statusTone>;
}

function deriveSystemPasses(events: SystemEventRow[]): SystemPass[] {
  const byEvent = new Map<string, SystemPass>();
  for (const e of events) {
    if (e.video_id) continue;
    const existing = byEvent.get(e.event);
    if (existing) {
      existing.count += 1;
      if (new Date(e.ts).getTime() > (storedMs(existing.lastTs) ?? 0)) {
        existing.lastTs = e.ts;
        existing.tone = statusTone(e.status);
        existing.agent = e.agent;
      }
    } else {
      byEvent.set(e.event, { event: e.event, agent: e.agent, count: 1, lastTs: e.ts, tone: statusTone(e.status) });
    }
  }
  return Array.from(byEvent.values()).sort(
    (a, b) => new Date(b.lastTs).getTime() - (storedMs(a.lastTs) ?? 0),
  );
}

const OVERALL_TONE: Record<Overall, "run" | "ok" | "fail" | "idle"> = {
  RUNNING: "run",
  COMPLETED: "ok",
  FAILED: "fail",
  "IN PROGRESS": "idle",
};

export default async function PipelinePage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  // Scope channel-owned queries to the selected channel (view control;
  // RLS still decides what may be read at all).
  const scope = await getChannelScope();

  const overallLabel: Record<Overall, string> = {
    RUNNING: t.status.running,
    COMPLETED: t.status.completed,
    FAILED: t.status.failed,
    "IN PROGRESS": t.status.inProgress,
  };

  const supabase = await createClient();
  let events: SystemEventRow[] = [];
  let dbError = false;

  if (supabase) {
    const ev = await scopeQuery(
        supabase.from("system_events").select("*"),
        scope, { nullIsGlobal: true },
      )
      .order("ts", { ascending: false })
      .limit(500);
    if (ev.error) dbError = true;
    events = (ev.data as SystemEventRow[]) ?? [];
  }

  const pipelines = derivePipelines(events, (k) => t.pipeline[k]).slice(0, 6);
  const passes = deriveSystemPasses(events);

  return (
    <div className="rhythm stagger-enter">
      <PageHeader
        icon="pipeline"
        title={t.pipeline.title}
        subtitle={fmt(t.pipeline.subtitle, { n: STAGES.length })}
        actions={<StageLegend />}
      />

      <Panel title={t.pipeline.videoPipelines}>
        {dbError ? (
          <EmptyState>{t.pipeline.dbErr}</EmptyState>
        ) : pipelines.length === 0 ? (
          <EmptyState>{t.pipeline.empty}</EmptyState>
        ) : (
          <div className="flex flex-col divide-y divide-[var(--color-border)]">
            {pipelines.map((p) => (
              <div key={p.videoId} className="flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="mono truncate text-[12px] text-[var(--color-fg)]">{p.videoId}</div>
                  <div className="flex items-center gap-3">
                    <span className="mono text-[10px] text-[var(--color-muted)]">
                      {p.lastActivity ? relativeTime(p.lastActivity) : t.common.na}
                    </span>
                    <StatusPill tone={OVERALL_TONE[p.overall]} label={overallLabel[p.overall]} live={p.overall === "RUNNING"} />
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <div className="min-w-[640px]">
                    <StageStrip stages={p.stages} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title={t.pipeline.systemPasses}>
        {passes.length === 0 ? (
          <EmptyState>{t.pipeline.noPasses}</EmptyState>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {passes.map((p) => {
              const color =
                p.tone === "ok"
                  ? "var(--color-ok)"
                  : p.tone === "fail"
                    ? "var(--color-fail)"
                    : p.tone === "run"
                      ? "var(--color-primary)"
                      : "var(--color-idle)";
              const stale = Date.now() - (storedMs(p.lastTs) ?? 0) > HEARTBEAT_MS;
              return (
                <li key={p.event} className="row-sweep flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-[var(--color-panel-2)]">
                  <span className="glow-dot size-1.5 shrink-0 rounded-full" style={{ color, background: color }} />
                  <span className="mono w-28 shrink-0 text-[11px] text-[var(--color-primary)]">
                    {p.agent ?? t.common.system}
                  </span>
                  <span className="truncate text-[var(--color-fg)]">{p.event}</span>
                  <span className="mono ml-auto shrink-0 text-[10px] text-[var(--color-muted)]">
                    {p.count}× · {timeOfDay(p.lastTs)} {stale ? t.pipeline.stale : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
