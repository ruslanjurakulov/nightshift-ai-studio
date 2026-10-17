"use client";

import { relativeTime, timeOfDay } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { fmt, type Dictionary } from "@/lib/i18n";
import { EmptyState, Panel } from "@/components/ui";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";
import { DataList } from "@/components/g4/DataList";
import { Section, Figures } from "@/components/g4/Section";
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
const CAP_LAMP: Record<CapabilityState, LampTone> = {
  automatic: "ok",
  records_only: "info",
  // Unconditional publishing is a real risk surface: a caution lamp, not green.
  unconditional: "warn",
  not_configured: "off",
};

const OUTCOME_KEY: Record<AutonomousAction["outcome"], keyof Dictionary["auto"]> = {
  ok: "outOk",
  failed: "outFailed",
  running: "outRunning",
  unknown: "outUnknown",
};
const OUTCOME_LAMP: Record<AutonomousAction["outcome"], LampTone> = {
  ok: "ok",
  failed: "fail",
  running: "run",
  unknown: "idle",
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
  const { t, locale } = useI18n();
  const weekday = (n: number) => String(t.auto[`wd${n}` as keyof Dictionary["auto"]]);

  return (
    <div className="g4-stack">
      {/* The desk: what this deployment really does on its own, and what it does not. */}
      <Section desk title={t.auto.postureTitle}>
        <ul className="g4-kv">
          {posture.map((p) => (
            <li key={p.key}>
              <div className="min-w-0">
                <div className="text-[var(--color-fg)]" style={{ fontSize: "0.9375rem" }}>
                  {String(t.auto[`p${p.key.charAt(0).toUpperCase()}${p.key.slice(1)}` as keyof Dictionary["auto"]])}
                </div>
                <div className="tnum g4-small g4-muted">
                  {p.evidenceTs ? fmt(t.auto.postureEvidence, { t: relativeTime(p.evidenceTs, locale) }) : t.auto.postureNoEvidence}
                </div>
              </div>
              <span className="shrink-0">
                <StatusLamp tone={CAP_LAMP[p.state]} label={String(t.auto[CAP_KEY[p.state]])} />
              </span>
            </li>
          ))}
        </ul>
        <p className="g4-note tnum mt-4" data-tone="warn">
          {t.auto.safetyNote}
        </p>
      </Section>

      <div className="g4-cols">
        <Panel title={t.auto.healthTitle}>
          <Figures cols={2}>
            {[
              { label: t.auto.hSuccessful, value: health.successful, color: "var(--color-ok)" },
              { label: t.auto.hFailed, value: health.failed, color: "var(--color-fail)" },
              { label: t.auto.hRunning, value: health.running, color: "var(--color-fg)" },
            ].map((s) => (
              <div key={s.label}>
                <div className="t-label">{s.label}</div>
                <div className="t-figure tnum mt-2" style={{ color: s.color }}>
                  <AnimatedNumber value={s.value} />
                </div>
              </div>
            ))}
            <div>
              <div className="t-label">{t.auto.hHuman}</div>
              <div className="t-figure tnum mt-2 g4-muted">{health.humanInterventions ?? t.common.na}</div>
            </div>
          </Figures>
          <p className="g4-note tnum mt-4">
            {fmt(t.auto.hWindow, { n: health.windowHours })} · {t.auto.hNote}
          </p>
        </Panel>

        <Panel title={t.auto.controlsTitle}>
          <EmptyState>{t.auto.controlsNotConfigured}</EmptyState>
        </Panel>
      </div>

      <div className="g4-cols">
        <Panel title={t.auto.windowTitle}>
          {!window ? (
            <EmptyState>{fmt(t.auto.windowInsufficient, { n: WINDOW_MIN_VIDEOS })}</EmptyState>
          ) : (
            <div>
              <div className="t-panel" style={{ color: "var(--ns-act-ink)" }}>
                {fmt(t.auto.windowBest, { day: weekday(window.weekday), hour: String(window.hour).padStart(2, "0") })}
              </div>
              <div className="tnum g4-muted mt-1">
                {fmt(t.auto.windowEvidence, { n: window.evidence, v: window.meanViewsPerDay.toFixed(1) })}
              </div>
              <p className="g4-note tnum mt-2">{t.auto.windowNote}</p>
            </div>
          )}
        </Panel>

        <Panel title={t.auto.dupTitle}>
          {duplicates.length === 0 ? (
            <EmptyState>{t.auto.dupNone}</EmptyState>
          ) : (
            <ul className="g4-kv">
              {duplicates.map((d) => (
                <li key={d.topic}>
                  <span className="k" style={{ color: "var(--color-fg)" }}>{d.topic}</span>
                  <span className="v tnum" style={{ color: "var(--color-warn)" }}>{fmt(t.auto.dupCount, { n: d.count })}</span>
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
          <DataList
            caption={t.auto.failuresTitle}
            rows={failures}
            rowKey={(f) => `${f.agent}-${f.event}`}
            columns={[
              { key: "event", label: t.auto.fEvent, render: (f) => <span className="mono" style={{ color: "var(--color-fail)" }}>{f.event}</span> },
              { key: "agent", label: t.auto.fAgent, render: (f) => <span className="mono" style={{ color: "var(--ns-act-ink)" }}>{f.agent}</span> },
              { key: "count", label: t.auto.fCount, align: "end", render: (f) => f.count },
              { key: "cause", label: t.auto.fCause, render: (f) => <span className="g4-muted">{f.cause ?? t.auto.fCauseUnknown}</span> },
              { key: "last", label: t.auto.fLast, nowrap: true, render: (f) => <span className="g4-muted tnum">{relativeTime(f.lastTs, locale)}</span> },
            ]}
          />
        )}
      </Panel>

      <Panel title={t.auto.actionsTitle}>
        {actions.length === 0 ? (
          <EmptyState>{t.auto.noActions}</EmptyState>
        ) : (
          <DataList
            caption={t.auto.actionsTitle}
            rows={actions}
            rowKey={(a) => a.id}
            columns={[
              {
                key: "when",
                label: t.auto.aWhen,
                nowrap: true,
                render: (a) => (
                  <span className="tnum g4-muted">
                    {timeOfDay(a.ts)} <span className="g4-small">· {relativeTime(a.ts, locale)}</span>
                  </span>
                ),
              },
              { key: "agent", label: t.auto.aAgent, render: (a) => <span className="mono" style={{ color: "var(--ns-act-ink)" }}>{a.agent}</span> },
              { key: "action", label: t.auto.aAction, render: (a) => <span className="mono">{a.event}</span> },
              { key: "video", label: t.auto.aVideo, render: (a) => <span className="mono g4-muted">{a.videoId ?? t.common.dash}</span> },
              { key: "outcome", label: t.auto.aOutcome, render: (a) => <StatusLamp tone={OUTCOME_LAMP[a.outcome]} label={String(t.auto[OUTCOME_KEY[a.outcome]])} /> },
            ]}
          />
        )}
      </Panel>
    </div>
  );
}
