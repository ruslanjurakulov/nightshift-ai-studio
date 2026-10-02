"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, CircleDashed, Loader2, MinusCircle, XCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { formatCredits } from "@/lib/credits";
import {
  ADVANCE_EVERY_MS,
  isRunActive,
  stepFailureReason,
  workflowErrorMessage,
  type RunStepView,
  type RunView,
} from "@/lib/workflows";
import { advanceRun, cancelRun, readRun } from "./workflowsApi";

/**
 * One run: every step's status and price, and the run's confirmed total.
 *
 * A member who may run workflows has this page carry the run on: every few
 * seconds it asks the database to settle the step that finished and start the
 * next one (advance_workflow_run) — as an ordinary generation under that
 * member's session, capped at the price confirmed for it. A step is held only
 * when it starts; one that has not started says so. Anyone else only reads.
 */
export function RunView({
  initial,
  canAct,
  toolLabels,
}: {
  initial: RunView;
  canAct: boolean;
  toolLabels: Record<string, string>;
}) {
  const { t, locale } = useI18n();
  const p = t.workflows.runPage;
  const path = useChannelPath();
  const [run, setRun] = useState<RunView>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const inFlight = useRef(false);
  const active = isRunActive(run);

  const tick = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    const out = canAct ? await advanceRun(initial.id) : await readRun(initial.id);
    inFlight.current = false;
    setRefreshing(false);
    if (out.ok) {
      setRun(out.value);
      setProblem(null);
    } else {
      setProblem(workflowErrorMessage(t, out.error));
    }
  }, [canAct, initial.id, t]);

  useEffect(() => {
    if (!active) return;
    // Straight away on opening (a run left waiting carries on), then on a timer.
    void tick();
    const timer = setInterval(() => void tick(), ADVANCE_EVERY_MS);
    return () => clearInterval(timer);
  }, [active, tick]);

  async function onStop() {
    setStopping(true);
    const out = await cancelRun(run.id);
    setStopping(false);
    if (out.ok) setRun(out.value);
    else setProblem(workflowErrorMessage(t, out.error));
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="panel flex flex-col gap-2 p-4" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 text-[15px] font-semibold">{fmt(p.of, { name: run.workflow_name })}</h2>
          <span className="pill border border-[var(--color-border)] px-3 py-1 text-[12px]">{t.workflows.status[run.status]}</span>
        </div>
        <p className="m-0 text-[13px] tabular-nums">{fmt(p.confirmed, { n: formatCredits(run.max_credits, locale) })}</p>
        <p className="m-0 text-[13px] tabular-nums">{fmt(p.charged, { n: formatCredits(run.charged_credits, locale) })}</p>
        {active ? (
          <p className="m-0 text-[12px] text-[var(--color-muted)]">
            {canAct ? p.keepOpen : p.viewOnly}
            {refreshing ? ` ${p.refreshing}` : ""}
          </p>
        ) : null}
        {!active && !canAct ? <p className="m-0 text-[12px] text-[var(--color-muted)]">{p.viewOnly}</p> : null}
        {problem ? (
          <p role="alert" className="m-0 flex flex-wrap items-center gap-3 text-[13px] text-[var(--color-fail)]">
            {problem}
            <button type="button" onClick={() => void tick()} className="btn-sky is-quiet pill px-3 py-1.5 text-[12px]">
              {p.retry}
            </button>
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {active && canAct ? (
            <button type="button" onClick={onStop} disabled={stopping} className="btn-sky ghost pill px-4 py-2 text-[13px]">
              {stopping ? p.cancelling : p.cancel}
            </button>
          ) : null}
          {!active && canAct ? (
            <Link href={path(`/workflows/${run.workflow_id}`)} className="btn-sky ghost pill px-4 py-2 text-[13px]">
              {p.newRun}
            </Link>
          ) : null}
        </div>
      </section>

      <section aria-label={p.stepsTitle} className="flex flex-col gap-2">
        <h2 className="m-0 text-[15px] font-semibold">{p.stepsTitle}</h2>
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {run.steps.map((s) => (
            <StepRow key={s.step_index} step={s} toolLabels={toolLabels} libraryHref={path("/library")} />
          ))}
        </ol>
      </section>
    </div>
  );
}

function StepIcon({ status, live }: { status: RunStepView["status"]; live: boolean }) {
  const cls = "size-4 shrink-0";
  if (status === "completed") return <Check className={`${cls} text-[var(--color-ok)]`} aria-hidden />;
  if (status === "failed") return <XCircle className={`${cls} text-[var(--color-fail)]`} aria-hidden />;
  if (status === "cancelled") return <AlertTriangle className={`${cls} text-[var(--color-muted)]`} aria-hidden />;
  if (status === "skipped") return <MinusCircle className={`${cls} text-[var(--color-muted)]`} aria-hidden />;
  if (status === "running" && live) return <Loader2 className={`${cls} animate-spin text-[var(--color-primary)]`} aria-hidden />;
  return <CircleDashed className={`${cls} text-[var(--color-muted)]`} aria-hidden />;
}

function StepRow({ step, toolLabels, libraryHref }: { step: RunStepView; toolLabels: Record<string, string>; libraryHref: string }) {
  const { t, locale } = useI18n();
  const p = t.workflows.runPage;
  const status = t.workflows.status as Record<string, string>;
  // While a step runs, the job's own state (queued, running…) is the honest word.
  const word = step.status === "running" && step.job_status === "queued" ? status.queued : status[step.status];
  return (
    <li className="studio-field flex flex-col gap-1 rounded-2xl border border-[var(--color-border)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-[13px] font-medium">
          <StepIcon status={step.status} live />
          {fmt(t.workflows.run.stepLine, { n: step.step_index + 1, tool: toolLabels[step.capability] ?? step.capability })}
        </span>
        <span className="text-[12px] text-[var(--color-muted)]">{word}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] tabular-nums text-[var(--color-muted)]">
        <span>{fmt(p.quoted, { n: formatCredits(step.quoted_credits, locale) })}</span>
        {step.status === "completed" && step.charged_credits !== null ? (
          <span>{fmt(p.chargedStep, { n: formatCredits(step.charged_credits, locale) })}</span>
        ) : null}
      </div>
      {step.status === "pending" || step.status === "skipped" ? (
        <p className="m-0 text-[12px] text-[var(--color-muted)]">{p.notStarted}</p>
      ) : null}
      {step.status === "failed" || step.status === "cancelled" ? (
        <p role="status" className="m-0 text-[12px] text-[var(--color-fail)]">
          {fmt(p.failedBecause, { why: stepFailureReason(t, step.error_code) })}
        </p>
      ) : null}
      {step.status === "completed" && step.result_asset_ids.length > 0 ? (
        <Link href={libraryHref} className="btn-sky ghost pill w-fit px-3 py-1.5 text-[12px]">
          {p.openResult}
        </Link>
      ) : null}
    </li>
  );
}
