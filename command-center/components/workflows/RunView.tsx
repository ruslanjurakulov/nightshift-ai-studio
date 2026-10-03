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
  confirmationDeadline,
  isRunActive,
  stepFailureReason,
  stepWaitCode,
  waitingStep,
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
 *
 * A step that cannot start yet for a reason that passes (everything the plan
 * may run at once is busy, or too few credits; 0083) is shown as waiting, with
 * what the run has been charged so far and when it stops if it still cannot
 * start. If the database refuses to let this member carry the run on (it
 * decides; e.g. the operator's organization needs a platform admin), the page
 * turns read-only and keeps refreshing instead of polling a refusal.
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
  // Whether this page carries the run on: the server's guess (canAct), until the
  // database refuses an advance — then read-only for good (BR-L-013).
  const [carry, setCarry] = useState(canAct);
  // The same, read by a tick already scheduled before the refusal re-rendered the page.
  const carrying = useRef(canAct);
  const inFlight = useRef(false);
  const active = isRunActive(run);
  const waiting = waitingStep(run);
  const deadline = waiting ? confirmationDeadline(run) : null;

  const tick = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    let out = carrying.current ? await advanceRun(initial.id) : await readRun(initial.id);
    if (carrying.current && !out.ok && out.error === "forbidden") {
      // Not this member's to carry on: follow it instead of asking again.
      carrying.current = false;
      setCarry(false);
      out = await readRun(initial.id);
    }
    inFlight.current = false;
    setRefreshing(false);
    if (out.ok) {
      setRun(out.value);
      setProblem(null);
    } else {
      setProblem(workflowErrorMessage(t, out.error));
    }
  }, [initial.id, t]);

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
      <section className="panel flex flex-col gap-2 p-5 sm:p-6" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 text-[15px] font-semibold">{fmt(p.of, { name: run.workflow_name })}</h2>
          <span className="pill border border-[var(--color-border)] px-3 py-1 text-xs">{t.workflows.status[run.status]}</span>
        </div>
        <p className="m-0 text-sm tabular-nums">
          {run.max_credits !== null ? fmt(p.confirmed, { n: formatCredits(run.max_credits, locale) }) : p.confirmedUnknown}
        </p>
        <p className="m-0 text-sm tabular-nums">
          {run.charged_credits !== null ? fmt(p.charged, { n: formatCredits(run.charged_credits, locale) }) : p.chargedUnknown}
        </p>
        {waiting ? (
          // The deadline is in the reader's own time zone, which the server cannot know.
          <p role="status" className="m-0 text-sm" suppressHydrationWarning>
            {fmt(waiting.wait === "run_limit_reached" ? p.waitingSlot : p.waitingCredits, { n: waiting.step_index + 1 })}{" "}
            {deadline
              ? fmt(p.waitingUntil, { when: deadline.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) })
              : p.waitingUntilUnknown}
          </p>
        ) : null}
        {active ? (
          <p className="m-0 text-xs text-[var(--color-muted)]">
            {carry ? p.keepOpen : p.viewOnly}
            {refreshing ? ` ${p.refreshing}` : ""}
          </p>
        ) : null}
        {!active && !carry ? <p className="m-0 text-xs text-[var(--color-muted)]">{p.viewOnly}</p> : null}
        {problem ? (
          <p role="alert" className="m-0 flex flex-wrap items-center gap-3 text-sm text-[var(--color-fail)]">
            {problem}
            <button type="button" onClick={() => void tick()} className="btn-sky is-quiet pill px-3 py-1.5 text-xs">
              {p.retry}
            </button>
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {active && carry ? (
            <button type="button" onClick={onStop} disabled={stopping} className="btn-sky ghost pill px-4 py-2 text-sm">
              {stopping ? p.cancelling : p.cancel}
            </button>
          ) : null}
          {!active && carry ? (
            <Link href={path(`/workflows/${run.workflow_id}`)} className="btn-sky ghost pill px-4 py-2 text-sm">
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
  const wait = stepWaitCode(step);
  return (
    <li className="studio-field flex flex-col gap-1 rounded-2xl border border-[var(--color-border)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-sm font-medium">
          <StepIcon status={step.status} live />
          {fmt(t.workflows.run.stepLine, { n: step.step_index + 1, tool: toolLabels[step.capability] ?? step.capability })}
        </span>
        <span className="text-xs text-[var(--color-muted)]">{word}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-[var(--color-muted)]">
        <span>{step.quoted_credits !== null ? fmt(p.quoted, { n: formatCredits(step.quoted_credits, locale) }) : p.quotedUnknown}</span>
        {step.status === "completed" && step.charged_credits !== null ? (
          <span>{fmt(p.chargedStep, { n: formatCredits(step.charged_credits, locale) })}</span>
        ) : null}
      </div>
      {wait ? (
        <p className="m-0 text-xs text-[var(--color-muted)]">{fmt(p.stepWaiting, { why: t.workflows.waitReasons[wait] })}</p>
      ) : step.status === "pending" || step.status === "skipped" ? (
        <p className="m-0 text-xs text-[var(--color-muted)]">{p.notStarted}</p>
      ) : null}
      {step.status === "failed" || step.status === "cancelled" ? (
        <p role="status" className="m-0 text-xs text-[var(--color-fail)]">
          {fmt(p.failedBecause, { why: stepFailureReason(t, step.error_code) })}
        </p>
      ) : null}
      {step.status === "completed" && step.result_asset_ids.length > 0 ? (
        <Link href={libraryHref} className="btn-sky ghost pill w-fit px-3 py-1.5 text-xs">
          {p.openResult}
        </Link>
      ) : null}
    </li>
  );
}
