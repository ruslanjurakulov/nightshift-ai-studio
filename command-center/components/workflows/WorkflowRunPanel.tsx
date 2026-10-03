"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Play } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { formatCredits } from "@/lib/credits";
import { SourcePicker } from "@/components/studio/SourcePicker";
import {
  emptyValues,
  inputLabel,
  newRunId,
  runBlock,
  valuesProblem,
  workflowErrorMessage,
  type Workflow,
  type WorkflowQuote,
} from "@/lib/workflows";
import { quoteWorkflow, runWorkflow } from "./workflowsApi";

const QUOTE_DELAY_MS = 350;
const field =
  "pill border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-base text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[13px]";

type QuoteState =
  | { status: "idle" }
  | { status: "quoting" }
  | { status: "ready"; quote: WorkflowQuote }
  | { status: "error"; message: string };

/**
 * The workflow's inputs, ONE total price and Run now.
 *
 * The total is the database's: every step priced the way the Studio prices a
 * generation, summed — and no total at all when any step cannot be priced, in
 * which case Run now stays off (never a 0). Pressing it asks for an explicit
 * confirmation of that total; what is sent is exactly the confirmed number
 * (max_credits), and the run id of the press, so pressing twice cannot start
 * two runs. Nothing is held until the confirmation, and then only the first
 * step is.
 */
export function WorkflowRunPanel({
  workflow,
  orgId,
  canRun,
  toolLabels,
}: {
  workflow: Workflow;
  orgId: string;
  canRun: boolean;
  toolLabels: Record<string, string>;
}) {
  const { t, locale } = useI18n();
  const r = t.workflows.run;
  const path = useChannelPath();
  const router = useRouter();
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>(() => emptyValues(workflow.inputs));
  const [state, setState] = useState<QuoteState>({ status: "idle" });
  const [confirming, setConfirming] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<number | null>(null);
  // One id per confirmation: a retry or a double press replays the same run.
  const runId = useRef<string | null>(null);
  const seq = useRef(0);

  const incomplete = valuesProblem(workflow.inputs, values) !== null;

  async function requote(v: Record<string, string>) {
    const mine = ++seq.current;
    setState({ status: "quoting" });
    const out = await quoteWorkflow(workflow.id, v);
    if (mine !== seq.current) return;
    setState(out.ok ? { status: "ready", quote: out.value } : { status: "error", message: workflowErrorMessage(t, out.error) });
  }

  useEffect(() => {
    if (incomplete) {
      seq.current++;
      setState({ status: "idle" });
      return;
    }
    const timer = setTimeout(() => void requote(values), QUOTE_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, incomplete, workflow.id, workflow.version]);

  const quote = state.status === "ready" ? state.quote : null;
  const block = quote ? runBlock(quote) : "unpriced";
  const total = quote?.total ?? null;
  const canPress = canRun && state.status === "ready" && block === null && total !== null && !busy;

  function press() {
    if (!canPress || total === null) return;
    runId.current = newRunId();
    setError(null);
    setMoved(null);
    setConfirming(total);
  }

  async function confirm() {
    if (confirming === null || !runId.current || !quote) return;
    setBusy(true);
    setError(null);
    const out = await runWorkflow(workflow.id, runId.current, quote.version, values, confirming);
    if (!out.ok) {
      setBusy(false);
      if (out.error === "price_changed") {
        // The price is not what was confirmed: nothing was held. Show the new one and ask again.
        const body = out.body as { detail?: unknown };
        const m = typeof body.detail === "string" ? /price=([\d.]+)/.exec(body.detail) : null;
        setMoved(m ? Number(m[1]) : null);
        setConfirming(null);
        void requote(values);
        return;
      }
      setError(workflowErrorMessage(t, out.error));
      return;
    }
    router.push(path(`/workflows/runs/${out.value.id}`));
  }

  const unpricedList = quote ? quote.unpriced_steps.map((i) => i + 1).join(", ") : "";

  return (
    <section aria-labelledby={`${id}-h`} className="flex flex-col gap-4">
      <div className="panel flex flex-col gap-3 p-5 sm:p-6">
        <h2 id={`${id}-h`} className="m-0 text-[15px] font-semibold">
          {r.inputsTitle}
        </h2>
        {workflow.inputs.length === 0 ? (
          <p className="m-0 text-sm text-[var(--color-muted)]">{r.noInputs}</p>
        ) : (
          workflow.inputs.map((i) =>
            i.kind === "text" ? (
              <label key={i.name} className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
                {inputLabel(i)}
                <textarea
                  value={values[i.name] ?? ""}
                  rows={3}
                  maxLength={4000}
                  disabled={confirming !== null || busy}
                  onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))}
                  className={`${field} rounded-2xl`}
                />
              </label>
            ) : (
              <div key={i.name} className="flex flex-col gap-1">
                <span className="text-xs text-[var(--color-muted)]">{inputLabel(i)}</span>
                {confirming !== null || busy ? (
                  <span className="text-xs text-[var(--color-muted)]">{values[i.name] ? "✓" : ""}</span>
                ) : (
                  <SourcePicker
                    orgId={orgId}
                    value={values[i.name] || null}
                    onChange={(v) => setValues((cur) => ({ ...cur, [i.name]: v }))}
                    libraryHref={path("/library")}
                    label={inputLabel(i)}
                  />
                )}
              </div>
            ),
          )
        )}
      </div>

      <div className="panel flex flex-col gap-3 p-5 sm:p-6" aria-live="polite">
        <h2 className="m-0 text-[15px] font-semibold">{r.totalTitle}</h2>
        {incomplete ? (
          <p className="m-0 text-sm text-[var(--color-muted)]">{r.fillIn}</p>
        ) : state.status === "quoting" || state.status === "idle" ? (
          <p className="m-0 inline-flex items-center gap-2 text-sm text-[var(--color-muted)]">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {r.quoting}
          </p>
        ) : state.status === "error" ? (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="m-0 text-sm text-[var(--color-fail)]">
              {state.message}
            </p>
            <button type="button" onClick={() => void requote(values)} className="btn-sky is-quiet pill px-3 py-1.5 text-xs">
              {r.retry}
            </button>
          </div>
        ) : (
          <>
            <p className="m-0 text-[22px] font-semibold tabular-nums">
              {total !== null ? fmt(r.totalValue, { n: formatCredits(total, locale) }) : r.noTotal}
            </p>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {state.quote.steps.map((s) => (
                <li key={s.step_index} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span>{fmt(r.stepLine, { n: s.step_index + 1, tool: toolLabels[s.capability] ?? s.capability })}</span>
                  <span className={s.priced ? "tabular-nums" : "text-[var(--color-fail)]"}>
                    {s.priced ? fmt(r.stepPrice, { n: formatCredits(s.credits, locale) }) : r.stepNoPrice}
                  </span>
                </li>
              ))}
            </ul>
            {state.quote.steps.some((s) => s.chained && s.priced) ? (
              <p className="m-0 text-xs text-[var(--color-muted)]">{r.chainedNote}</p>
            ) : null}
            {block === "unpriced" ? (
              <p role="alert" className="m-0 text-sm text-[var(--color-fail)]">
                {fmt(r.noTotalWhy, { steps: unpricedList })}
              </p>
            ) : null}
            {block === "insufficient" && total !== null ? (
              <p role="alert" className="m-0 flex flex-wrap items-center gap-3 text-sm text-[var(--color-fail)]">
                {fmt(r.notEnough, { have: formatCredits(state.quote.available, locale), need: formatCredits(total, locale) })}
                <Link href={path("/credits")} className="btn-sky ghost pill px-3 py-1.5 text-xs">
                  {r.addCredits}
                </Link>
              </p>
            ) : null}
            {block === null && !state.quote.exempt && state.quote.available !== null ? (
              <p className="m-0 text-xs text-[var(--color-muted)]">
                {fmt(r.available, { n: formatCredits(state.quote.available, locale) })}
              </p>
            ) : null}
            <p className="m-0 text-xs text-[var(--color-muted)]">{r.holdNote}</p>
          </>
        )}

        {moved !== null ? (
          <p role="alert" className="m-0 text-sm text-[var(--color-fail)]">
            {fmt(r.priceChanged, { n: formatCredits(moved, locale) })}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="m-0 text-sm text-[var(--color-fail)]">
            {error}
          </p>
        ) : null}

        {!canRun ? <p className="m-0 text-sm text-[var(--color-muted)]">{r.readOnly}</p> : null}

        {confirming !== null ? (
          <div role="alertdialog" aria-labelledby={`${id}-c`} className="studio-field flex flex-col gap-2 rounded-2xl border border-[var(--color-primary)] p-3">
            <h3 id={`${id}-c`} className="m-0 text-sm font-semibold">
              {r.confirmTitle}
            </h3>
            <p className="m-0 text-sm">{fmt(r.confirmBody, { n: formatCredits(confirming, locale) })}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={confirm} disabled={busy} className="btn-sky is-solid pill inline-flex items-center gap-2 px-4 py-2 text-sm">
                {busy ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    {r.starting}
                  </>
                ) : (
                  r.confirm
                )}
              </button>
              <button type="button" onClick={() => setConfirming(null)} disabled={busy} className="btn-sky is-quiet pill px-4 py-2 text-sm">
                {r.back}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <button
              type="button"
              onClick={press}
              disabled={!canPress}
              className="btn-sky is-solid pill inline-flex items-center gap-2 px-4 py-2 text-sm"
            >
              <Play className="size-4" aria-hidden />
              {total !== null && canPress ? fmt(r.runNow, { n: formatCredits(total, locale) }) : r.runNowOff}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
