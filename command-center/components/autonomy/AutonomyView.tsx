"use client";

import { relativeTime, timeOfDay } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { fmt, type Dictionary } from "@/lib/i18n";
import { EmptyState, Panel } from "@/components/ui";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import {
  WINDOW_MIN_VIDEOS,
  type AutonomousAction,
  type AutonomyHealth,
  type CapabilityState,
  type DuplicateGroup,
  type FailureGroup,
  type PostureItem,
  type PublishingWindow,
} from "@/lib/autonomy";

const CAP_KEY: Record<CapabilityState, keyof Dictionary["auto"]> = {
  automatic: "capAutomatic",
  records_only: "capRecordsOnly",
  unconditional: "capUnconditional",
  not_configured: "capNotConfigured",
};
const CAP_COLOR: Record<CapabilityState, string> = {
  automatic: "var(--color-ok)",
  records_only: "var(--color-secondary)",
  // Unconditional publishing is a real risk surface — amber, not green.
  unconditional: "var(--color-warn)",
  not_configured: "var(--color-muted)",
};

const OUTCOME_KEY: Record<AutonomousAction["outcome"], keyof Dictionary["auto"]> = {
  ok: "outOk",
  failed: "outFailed",
  running: "outRunning",
  unknown: "outUnknown",
};
const OUTCOME_COLOR: Record<AutonomousAction["outcome"], string> = {
  ok: "var(--color-ok)",
  failed: "var(--color-fail)",
  running: "var(--color-primary)",
  unknown: "var(--color-muted)",
};

/**
 * The autonomy control centre. Everything here reports the deployment's real
 * behaviour; where the backend has no mechanism the panel says NOT CONFIGURED
 * instead of offering a control that would do nothing.
 */
export function AutonomyView({
  posture,
  health,
  actions,
  failures,
  window,
  duplicates,
}: {
  posture: PostureItem[];
  health: AutonomyHealth;
  actions: AutonomousAction[];
  failures: FailureGroup[];
  window: PublishingWindow | null;
  duplicates: DuplicateGroup[];
}) {
  const { t } = useI18n();
  const weekday = (n: number) => String(t.auto[`wd${n}` as keyof Dictionary["auto"]]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={t.auto.postureTitle}>
          <ul className="divide-y divide-[var(--color-border)]">
            {posture.map((p) => {
              const color = CAP_COLOR[p.state];
              return (
                <li key={p.key} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="text-sm text-[var(--color-fg)]">
                      {String(t.auto[`p${p.key.charAt(0).toUpperCase()}${p.key.slice(1)}` as keyof Dictionary["auto"]])}
                    </div>
                    <div className="tnum text-xs text-[var(--color-muted)]">
                      {p.evidenceTs ? fmt(t.auto.postureEvidence, { t: relativeTime(p.evidenceTs) }) : t.auto.postureNoEvidence}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs font-semibold" style={{ color }}>
                    {String(t.auto[CAP_KEY[p.state]])}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="border-t border-[var(--color-border)] px-4 py-2 tnum text-xs leading-relaxed text-[var(--color-warn)]">
            {t.auto.safetyNote}
          </p>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title={t.auto.healthTitle}>
            <div className="grid grid-cols-2 gap-3 p-4">
              {[
                { label: t.auto.hSuccessful, value: health.successful, color: "var(--color-ok)" },
                { label: t.auto.hFailed, value: health.failed, color: "var(--color-fail)" },
                { label: t.auto.hRunning, value: health.running, color: "var(--color-primary)" },
              ].map((s) => (
                <div key={s.label} className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2">
                  <div className="text-xs text-[var(--color-muted)]">{s.label}</div>
                  <div className="tnum text-xl font-bold tabular-nums" style={{ color: s.color }}>
                    <AnimatedNumber value={s.value} />
                  </div>
                </div>
              ))}
              <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2">
                <div className="text-xs text-[var(--color-muted)]">{t.auto.hHuman}</div>
                <div className="tnum text-xl font-bold tabular-nums text-[var(--color-muted)]">
                  {health.humanInterventions ?? t.common.na}
                </div>
              </div>
            </div>
            <p className="border-t border-[var(--color-border)] px-4 py-2 tnum text-xs text-[var(--color-muted)]">
              {fmt(t.auto.hWindow, { n: health.windowHours })} · {t.auto.hNote}
            </p>
          </Panel>

          <Panel title={t.auto.controlsTitle}>
            <EmptyState>{t.auto.controlsNotConfigured}</EmptyState>
          </Panel>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={t.auto.windowTitle}>
          {!window ? (
            <EmptyState>{fmt(t.auto.windowInsufficient, { n: WINDOW_MIN_VIDEOS })}</EmptyState>
          ) : (
            <div className="p-4">
              <div className="font-display text-base font-semibold text-[var(--color-primary)]">
                {fmt(t.auto.windowBest, { day: weekday(window.weekday), hour: String(window.hour).padStart(2, "0") })}
              </div>
              <div className="tnum mt-1 text-xs text-[var(--color-muted)]">
                {fmt(t.auto.windowEvidence, { n: window.evidence, v: window.meanViewsPerDay.toFixed(1) })}
              </div>
              <p className="tnum mt-2 text-xs text-[var(--color-muted)]">{t.auto.windowNote}</p>
            </div>
          )}
        </Panel>

        <Panel title={t.auto.dupTitle}>
          {duplicates.length === 0 ? (
            <EmptyState>{t.auto.dupNone}</EmptyState>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {duplicates.map((d) => (
                <li key={d.topic} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="min-w-0 truncate text-sm text-[var(--color-fg)]">{d.topic}</span>
                  <span className="tnum shrink-0 text-xs text-[var(--color-warn)]">
                    {fmt(t.auto.dupCount, { n: d.count })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title={t.auto.failuresTitle}>
        {failures.length === 0 ? (
          <EmptyState>{t.auto.noFailures}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-muted)]">
                  <th className="px-4 py-2 font-semibold">{t.auto.fEvent}</th>
                  <th className="px-4 py-2 font-semibold">{t.auto.fAgent}</th>
                  <th className="px-4 py-2 text-right font-semibold">{t.auto.fCount}</th>
                  <th className="px-4 py-2 font-semibold">{t.auto.fCause}</th>
                  <th className="px-4 py-2 font-semibold">{t.auto.fLast}</th>
                </tr>
              </thead>
              <tbody>
                {failures.map((f) => (
                  <tr key={`${f.agent}-${f.event}`} className="border-b border-[var(--color-border)]/50 transition-colors hover:bg-[var(--color-panel-2)]">
                    <td className="px-4 py-2 mono text-xs text-[var(--color-fail)]">{f.event}</td>
                    <td className="px-4 py-2 mono text-xs text-[var(--color-primary)]">{f.agent}</td>
                    <td className="px-4 py-2 text-right tnum tabular-nums text-[var(--color-fg)]">{f.count}</td>
                    <td className="px-4 py-2 tnum text-xs text-[var(--color-muted)]">{f.cause ?? t.auto.fCauseUnknown}</td>
                    <td className="px-4 py-2 tnum text-xs text-[var(--color-muted)]">{relativeTime(f.lastTs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={t.auto.actionsTitle}>
        {actions.length === 0 ? (
          <EmptyState>{t.auto.noActions}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-muted)]">
                  <th className="px-4 py-2 font-semibold">{t.auto.aWhen}</th>
                  <th className="px-4 py-2 font-semibold">{t.auto.aAgent}</th>
                  <th className="px-4 py-2 font-semibold">{t.auto.aAction}</th>
                  <th className="px-4 py-2 font-semibold">{t.auto.aVideo}</th>
                  <th className="px-4 py-2 font-semibold">{t.auto.aOutcome}</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((a) => (
                  <tr key={a.id} className="border-b border-[var(--color-border)]/50 transition-colors hover:bg-[var(--color-panel-2)]">
                    <td className="whitespace-nowrap px-4 py-2 tnum text-xs text-[var(--color-muted)]">
                      <div>{timeOfDay(a.ts)}</div>
                      <div className="text-xs opacity-70">{relativeTime(a.ts)}</div>
                    </td>
                    <td className="px-4 py-2 mono text-xs text-[var(--color-primary)]">{a.agent}</td>
                    <td className="px-4 py-2 mono text-xs text-[var(--color-fg)]">{a.event}</td>
                    <td className="px-4 py-2 tnum text-xs text-[var(--color-muted)]">{a.videoId ?? t.common.dash}</td>
                    <td className="px-4 py-2 text-xs font-semibold" style={{ color: OUTCOME_COLOR[a.outcome] }}>
                      {String(t.auto[OUTCOME_KEY[a.outcome]])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
