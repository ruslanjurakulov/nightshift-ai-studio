"use client";

import { useI18n } from "@/lib/i18n/context";
import type { Confidence } from "@/lib/decisions";
import type { TopicState } from "@/lib/memory";
import type { Dictionary } from "@/lib/i18n";

const CONF_KEY: Record<Confidence, keyof Dictionary["intel"]> = {
  LOW: "confLow",
  MEDIUM: "confMedium",
  HIGH: "confHigh",
};
const CONF_COLOR: Record<Confidence, string> = {
  LOW: "var(--color-warn)",
  MEDIUM: "var(--color-secondary)",
  HIGH: "var(--color-ok)",
};

/** Confidence as evidence strength — never a fabricated percentage. */
export function ConfidenceBadge({ confidence }: { confidence: Confidence | null }) {
  const { t } = useI18n();
  const label = confidence ? String(t.intel[CONF_KEY[confidence]]) : String(t.intel.confNone);
  const color = confidence ? CONF_COLOR[confidence] : "var(--color-muted)";
  return (
    <span
      className="rounded border px-1.5 py-0.5 text-xs font-semibold"
      style={{ color, borderColor: color, background: "color-mix(in srgb, currentColor 8%, transparent)" }}
    >
      {label}
    </span>
  );
}

const STATE_COLOR: Record<TopicState, string> = {
  RISING: "var(--color-ok)",
  STABLE: "var(--color-secondary)",
  DECLINING: "var(--color-fail)",
  NEW: "var(--color-primary)",
  INSUFFICIENT_DATA: "var(--color-muted)",
};

export function TopicStateBadge({ state }: { state: TopicState }) {
  const { t } = useI18n();
  const color = STATE_COLOR[state];
  const label = String(t.intel[`state${state}` as keyof Dictionary["intel"]]);
  return (
    <span className="text-xs font-semibold" style={{ color }}>
      {label}
    </span>
  );
}

/** Localized metric name for a FeedbackEngine signal metric token. */
export function useMetricLabel() {
  const { t } = useI18n();
  return (metric: string) => {
    const key = `metric${metric}` as keyof Dictionary["intel"];
    const value = t.intel[key];
    return value ? String(value) : metric;
  };
}
