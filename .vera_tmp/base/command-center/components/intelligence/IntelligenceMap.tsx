"use client";

import { useMemo } from "react";
import { useRealtimeEvents } from "@/lib/useRealtimeEvents";
import type { ChannelScope } from "@/lib/channels";
import { useI18n } from "@/lib/i18n/context";
import type { Dictionary } from "@/lib/i18n";
import type { SystemEventRow } from "@/lib/types";
import { storedMs } from "@/lib/format";
import { StatusLamp } from "@/components/ui/StatusLamp";

type NodeKey =
  | "audience"
  | "trends"
  | "competitors"
  | "intelligence"
  | "topicManager"
  | "video"
  | "youtube"
  | "analytics"
  | "learning";

const W = 340;
const H = 600;

const POS: Record<NodeKey, [number, number]> = {
  audience: [170, 42],
  trends: [95, 122],
  competitors: [245, 122],
  intelligence: [170, 206],
  topicManager: [170, 290],
  video: [170, 370],
  youtube: [170, 446],
  analytics: [170, 520],
  learning: [66, 406],
};

const LABEL: Record<NodeKey, keyof Dictionary["ops"]> = {
  audience: "nodeAudience",
  trends: "nodeTrends",
  competitors: "nodeCompetitors",
  intelligence: "nodeIntelligence",
  topicManager: "nodeTopicManager",
  video: "nodeVideo",
  youtube: "nodeYoutube",
  analytics: "nodeAnalytics",
  learning: "nodeLearning",
};

const EDGES: [NodeKey, NodeKey][] = [
  ["audience", "trends"],
  ["audience", "competitors"],
  ["trends", "intelligence"],
  ["competitors", "intelligence"],
  ["intelligence", "topicManager"],
  ["topicManager", "video"],
  ["video", "youtube"],
  ["youtube", "analytics"],
  ["analytics", "learning"],
  ["learning", "topicManager"],
];

const DAY_MS = 24 * 60 * 60 * 1000;

function matches(node: NodeKey, ev: string): boolean {
  const e = ev.toLowerCase();
  switch (node) {
    case "audience":
      return e.startsWith("demand") || e.startsWith("comment") || e.startsWith("audience");
    case "trends":
      return e.includes("trend") || e === "system.heartbeat" || e.startsWith("intelligence");
    case "competitors":
      return e.includes("competitor");
    case "intelligence":
      return e === "system.heartbeat" || e.startsWith("intelligence");
    case "topicManager":
      return e.startsWith("topic");
    case "video":
      return e.startsWith("video") || e.startsWith("script") || e.startsWith("voice") || e.startsWith("media") || e.startsWith("render") || e.startsWith("thumbnail") || e.startsWith("research");
    case "youtube":
      return e.startsWith("upload") || e === "video.published";
    case "analytics":
      return e.startsWith("analytics") || e.includes("metrics") || e === "feedback.generated";
    case "learning":
      return e.startsWith("feedback");
  }
}

/** How Nightshift intelligence flows. Each node lights up when a matching real
 *  event landed in the last 24h; edges animate out of an active source. No
 *  activity anywhere means the map is honestly quiet, not faked into motion. */
export function IntelligenceMap({
  initial,
  scope,
}: {
  initial: SystemEventRow[];
  /** The page's channel scope — live events outside it are dropped. */
  scope: ChannelScope;
}) {
  const { t } = useI18n();
  const { events } = useRealtimeEvents(initial, "chronos_intel", scope);

  const active = useMemo(() => {
    const recent = events.filter((e) => Date.now() - (storedMs(e.ts) ?? 0) < DAY_MS);
    const set = new Set<NodeKey>();
    for (const key of Object.keys(POS) as NodeKey[]) {
      if (recent.some((e) => matches(key, e.event))) set.add(key);
    }
    return set;
  }, [events]);

  const anyActive = active.size > 0;
  const keys = Object.keys(POS) as NodeKey[];

  return (
    <section className="ns-desk" aria-label={t.ops.intelTitle}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <p className="g4-note">{t.ops.intelRecent}</p>
        <StatusLamp
          tone={anyActive ? "run" : "idle"}
          label={anyActive ? t.ops.intelActive : t.ops.intelQuiet}
        />
      </div>

      <div className="g4-map">
        <div className="relative mx-auto w-full max-w-sm" style={{ aspectRatio: `${W} / ${H}` }}>
          <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" aria-hidden>
            {EDGES.map(([a, b], i) => {
              const [x1, y1] = POS[a];
              const [x2, y2] = POS[b];
              const on = active.has(a);
              return (
                <line
                  key={i}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={on ? "var(--ns-amber)" : "var(--ns-rule-strong)"}
                  strokeWidth={on ? 1.8 : 1}
                  strokeOpacity={on ? 0.95 : 0.55}
                />
              );
            })}
          </svg>

          {keys.map((k) => {
            const [x, y] = POS[k];
            const on = active.has(k);
            return (
              <div
                key={k}
                aria-hidden
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%` }}
              >
                <span className="g4-map-node" data-on={on}>
                  <span className="ns-lamp" data-tone={on ? "run" : "idle"} />
                  {String(t.ops[LABEL[k]])}
                </span>
              </div>
            );
          })}
        </div>

        {/* The same path in words: each stage and whether anything landed for it in the last 24 hours. */}
        <ol className="g4-kv">
          {keys.map((k) => {
            const on = active.has(k);
            return (
              <li key={k}>
                <span className="k" style={{ color: "var(--color-fg)" }}>
                  {String(t.ops[LABEL[k]])}
                </span>
                <span className="v">
                  <StatusLamp tone={on ? "run" : "idle"} label={on ? t.ops.intelActive : t.ops.intelQuiet} />
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
