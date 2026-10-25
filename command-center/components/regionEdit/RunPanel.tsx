"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { apiErrorMessage, errorAction } from "@/lib/creative/studio";
import { formatCredits } from "@/lib/credits";
import { MAX_REGIONS, MIN_REGION_PX, toWire, type EditorRegion } from "@/lib/regionEdit/geometry";
import { REGION_ERRORS } from "@/lib/regionEdit/request";
import { isFinalPhase, type RegionResult, type RunView } from "@/lib/regionEdit/run";
import { useRegionJob } from "@/components/regionEdit/useRegionJob";
import type { RegionQuoteState } from "@/components/regionEdit/useRegionQuote";

type Start = { kind: "idle" } | { kind: "starting" } | { kind: "error"; code: string };

const newKey = () => `re-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;

/**
 * Run the regions as drawn and show what happened to each one.
 *
 * The button writes one row and stops (CLAUDE.md rule 3): /api/region-edit/run asks the database to hold the price the person
 * just saw (`max_credits`) and queue the job. What follows is read, not driven, from here: each region is applied, failed or
 * refused, only the applied ones are charged, and the rest of the hold is given back. One idempotency key per press: a double
 * click, a retry after a dropped answer and a second tab all name the same job, so a press can never pay twice.
 */
export function RunPanel({
  orgId,
  sourceId,
  ready,
  model,
  feather,
  regions,
  quote,
  jobId,
  onJob,
  onRequote,
  onFinished,
  onOpenVersion,
  creditsHref,
}: {
  orgId: string;
  sourceId: string | null;
  ready: boolean;
  model: string;
  feather: number;
  regions: readonly EditorRegion[];
  quote: RegionQuoteState;
  jobId: string | null;
  onJob: (id: string | null) => void;
  onRequote: () => void;
  onFinished: (view: RunView) => void;
  onOpenVersion: (assetId: string) => void;
  creditsHref: string;
}) {
  const { t, fmt, locale } = useI18n();
  const r = t.regionEdit;
  const [start, setStart] = useState<Start>({ kind: "idle" });
  const attempt = useRef<{ sig: string; key: string } | null>(null);
  const job = useRegionJob(jobId);
  const view = job.status === "ready" ? job.view : null;
  const active = jobId !== null && !(view && isFinalPhase(view.phase));
  const priced = quote.status === "ready";
  const canRun = ready && Boolean(sourceId) && Boolean(model) && priced && start.kind !== "starting" && !active;

  // Told once per job when it ends, so the versions are read again and the new picture can be opened.
  const told = useRef<string | null>(null);
  useEffect(() => {
    if (view && isFinalPhase(view.phase) && told.current !== view.id) {
      told.current = view.id;
      onFinished(view);
    }
  }, [view, onFinished]);

  async function run() {
    if (!canRun || quote.status !== "ready" || !sourceId) return;
    const body = { org_id: orgId, source_asset_id: sourceId, model, feather, regions: toWire(regions), max_credits: quote.quote.total };
    const sig = JSON.stringify(body);
    // The same press, retried, names the same job; changed regions, a changed price or another model are another request.
    if (!attempt.current || attempt.current.sig !== sig) attempt.current = { sig, key: newKey() };
    setStart({ kind: "starting" });
    try {
      const res = await fetch("/api/region-edit/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, idempotency_key: attempt.current.key }),
      });
      const out = (await res.json().catch(() => ({}))) as { job?: { id?: unknown }; error?: unknown };
      if ((res.status === 201 || res.status === 200) && out.job && typeof out.job.id === "string") {
        attempt.current = null;
        setStart({ kind: "idle" });
        onJob(out.job.id);
        return;
      }
      const code = typeof out.error === "string" ? out.error : "failed";
      // A price that moved is asked for again; the key stays, so a retry cannot pay twice either way.
      if (errorAction(code) === "requote") onRequote();
      setStart({ kind: "error", code });
    } catch {
      setStart({ kind: "error", code: "failed" });
    }
  }

  async function cancel() {
    if (!jobId) return;
    try {
      await fetch(`/api/creative/jobs/${encodeURIComponent(jobId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
    } catch {
      /* the next read of the job says what happened */
    }
  }

  const startMessage = useMemo(() => {
    if (start.kind !== "error") return null;
    const own = (REGION_ERRORS as readonly string[]).includes(start.code);
    return own
      ? fmt((r.errors as Record<string, string>)[start.code] ?? r.errors.failed, { max: MAX_REGIONS, min: MIN_REGION_PX })
      : apiErrorMessage(t, start.code);
  }, [start, fmt, r, t]);

  return (
    <div className="flex flex-col gap-3">
      <button type="button" className="btn-primary w-fit" disabled={!canRun} aria-disabled={!canRun} aria-describedby="re-run-why" onClick={() => void run()}>
        {start.kind === "starting" ? r.starting : r.run}
      </button>
      <p id="re-run-why" className="text-xs text-[var(--color-muted)]">{active ? r.runBusy : r.runWhy}</p>
      {startMessage ? (
        <div className="flex flex-wrap items-center gap-3" role="alert">
          <p className="text-sm text-[var(--color-fail)]">{startMessage}</p>
          {start.kind === "error" && errorAction(start.code) === "credits" ? (
            <Link className="btn-quiet" href={creditsHref}>{r.addCredits}</Link>
          ) : null}
        </div>
      ) : null}

      {jobId ? (
        <section aria-labelledby="re-result" className="flex flex-col gap-3 rounded-[var(--ns-r-panel)] border border-[var(--color-border)] p-3" data-testid="run-result">
          <h3 id="re-result" className="studio-label">{r.resultTitle}</h3>
          {job.status === "loading" ? <p className="text-sm text-[var(--color-muted)]" role="status">{r.jobLoading}</p> : null}
          {job.status === "error" ? (
            <p className="text-sm text-[var(--color-fail)]" role="alert">{job.code === "not_found" ? r.jobGone : r.jobUnreadable}</p>
          ) : null}
          {view ? (
            <>
              {job.status === "ready" && job.stale ? <p className="text-xs text-[var(--color-muted)]" role="status">{r.jobStale}</p> : null}
              <p className="text-sm font-medium" role="status" aria-live="polite">{phaseLine(view, r, fmt)}</p>
              {view.regions.length > 0 ? (
                <ul className="flex flex-col gap-2" aria-label={r.resultTitle}>
                  {view.regions.map((x) => (
                    <li key={x.id} className="flex flex-wrap items-baseline justify-between gap-2" data-testid="region-result">
                      <span className="min-w-0 break-words text-sm">{x.name}</span>
                      <span className="text-sm text-[var(--color-muted)]">{regionLine(x, view, r)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {isFinalPhase(view.phase) && view.charged !== null ? (
                <p className="text-sm" data-testid="run-money">
                  {view.charged > 0
                    ? fmt(r.moneyDone, { charged: formatCredits(view.charged, locale), held: formatCredits(view.held, locale), released: formatCredits(view.released ?? 0, locale) })
                    : fmt(r.moneyNone, { held: formatCredits(view.held, locale) })}
                </p>
              ) : view.phase === "queued" || view.phase === "running" ? (
                <p className="text-xs text-[var(--color-muted)]">{fmt(r.moneyHeld, { held: formatCredits(view.held, locale) })}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {view.phase === "completed" && view.resultAssetId ? (
                  <button type="button" className="btn-primary" onClick={() => onOpenVersion(view.resultAssetId!)}>{r.openVersion}</button>
                ) : null}
                {view.phase === "queued" ? (
                  <button type="button" className="btn-quiet" onClick={() => void cancel()}>{r.cancel}</button>
                ) : null}
                {isFinalPhase(view.phase) ? (
                  <button type="button" className="btn-quiet" onClick={() => onJob(null)}>{r.dismiss}</button>
                ) : null}
              </div>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

type R = ReturnType<typeof useI18n>["t"]["regionEdit"];
type Fmt = ReturnType<typeof useI18n>["fmt"];

function phaseLine(view: RunView, r: R, fmt: Fmt): string {
  switch (view.phase) {
    case "queued":
      return r.jobQueued;
    case "running":
      return r.jobRunning;
    case "completed":
      return fmt(r.jobDone, { applied: view.appliedCount, total: view.regions.length });
    case "cancelled":
      return r.jobCancelled;
    case "expired":
      return r.failures.not_picked_up;
    case "failed": {
      const f = view.failure;
      return (f && (r.failures as Record<string, string>)[f]) || r.failures.other;
    }
  }
}

function regionLine(x: RegionResult, view: RunView, r: R): string {
  if (x.status === "applied") return r.regionApplied;
  if (x.status === null) return isFinalPhase(view.phase) ? r.regionNotTried : r.regionWaiting;
  const label = x.status === "failed" ? r.regionFailed : r.regionRefused;
  const why = x.reason ? (r.reasons as Record<string, string>)[x.reason] ?? r.reasons.provider_error : r.reasons.provider_error;
  return `${label}. ${why} ${r.notCharged}`;
}
