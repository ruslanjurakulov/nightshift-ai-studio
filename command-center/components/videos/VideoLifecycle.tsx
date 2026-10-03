"use client";

import { timeOfDay } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import type { Dictionary } from "@/lib/i18n";
import type { SystemEventRow } from "@/lib/types";

type State = "COMPLETED" | "RUNNING" | "FAILED" | "WAITING";

const COLOR: Record<State, string> = {
  COMPLETED: "var(--color-ok)",
  RUNNING: "var(--color-primary)",
  FAILED: "var(--color-fail)",
  WAITING: "var(--color-idle)",
};

/** The real per-video lifecycle: each stage's state is read off this video's
 *  stored events (analytics/learning from whether snapshots/signals exist).
 *  Nothing is marked complete without a real event or record. */
export function VideoLifecycle({
  events,
  hasMetrics,
  hasLearning,
}: {
  events: SystemEventRow[];
  hasMetrics: boolean;
  hasLearning: boolean;
}) {
  const { t } = useI18n();

  const has = (ev: string) => events.find((e) => e.event === ev) ?? null;
  const anyStart = (base: string) => events.find((e) => e.event === `${base}.started`) ?? null;
  const anyFail = (base: string) => events.find((e) => e.event === `${base}.failed`) ?? null;

  function pipelineStage(bases: string[], completedEvents: string[]): { state: State; ts: string | null } {
    for (const ce of completedEvents) {
      const hit = has(ce);
      if (hit) return { state: "COMPLETED", ts: hit.ts };
    }
    for (const b of bases) {
      const f = anyFail(b);
      if (f) return { state: "FAILED", ts: f.ts };
    }
    for (const b of bases) {
      const s = anyStart(b);
      if (s) return { state: "RUNNING", ts: s.ts };
    }
    return { state: "WAITING", ts: null };
  }

  const boolStage = (ok: boolean): { state: State; ts: string | null } => ({ state: ok ? "COMPLETED" : "WAITING", ts: null });

  const stages: { labelKey: keyof Dictionary["pipeline"] | null; opsKey?: keyof Dictionary["ops"]; detailKey?: keyof Dictionary["videoDetail"]; s: { state: State; ts: string | null } }[] = [
    { labelKey: "sTopic", s: pipelineStage(["topic"], ["topic.selected", "topic.completed"]) },
    { labelKey: "sResearch", s: pipelineStage(["research"], ["research.completed"]) },
    { labelKey: "sScript", s: pipelineStage(["script"], ["script.completed"]) },
    { labelKey: "sVoice", s: pipelineStage(["voice"], ["voice.completed"]) },
    { labelKey: "sMedia", s: pipelineStage(["media", "thumbnail"], ["media.completed", "thumbnail.completed"]) },
    { labelKey: "sRender", s: pipelineStage(["render"], ["render.completed"]) },
    { labelKey: "sPublish", s: pipelineStage(["video", "upload"], ["video.published", "upload.completed"]) },
    { labelKey: null, detailKey: "analytics", s: boolStage(hasMetrics) },
    { labelKey: null, opsKey: "nodeLearning", s: boolStage(hasLearning) },
  ];

  return (
    <ol className="flex flex-col p-4">
      {stages.map((st, i) => {
        const color = COLOR[st.s.state];
        const filled = st.s.state !== "WAITING";
        const label = st.labelKey ? t.pipeline[st.labelKey] : st.detailKey ? t.videoDetail[st.detailKey] : st.opsKey ? t.ops[st.opsKey] : "";
        const last = i === stages.length - 1;
        return (
          <li key={i} className="flex items-stretch gap-3">
            <div className="flex flex-col items-center">
              <span
                className={st.s.state === "RUNNING" ? "glow-dot live-ring" : undefined}
                style={{ width: 12, height: 12, borderRadius: 999, background: filled ? color : "transparent", border: `2px solid ${color}` }}
              />
              {!last && <span className="w-[2px] flex-1" style={{ background: filled ? color : "var(--color-border)", opacity: filled ? 0.5 : 1, minHeight: 18 }} />}
            </div>
            <div className="flex flex-1 items-center justify-between gap-2 pb-3">
              <span className="text-sm" style={{ color: filled ? "var(--color-fg)" : "var(--color-muted)" }}>
                {String(label)}
              </span>
              <span className="text-xs" style={{ color }}>
                {st.s.ts ? timeOfDay(st.s.ts) : ""}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
