"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { StatusPill } from "@/components/ui";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import type { CreativeError } from "@/lib/creative/operations";
import {
  addDismissed,
  apiErrorMessage,
  asCreativeError,
  coerceJobs,
  creditsLine,
  failureReason,
  isActiveStatus,
  isUnsuccessful,
  kindLabel,
  prefillFromJob,
  readDismissed,
  resultHref,
  statusView,
  truncate,
  type StudioJob,
  type StudioModel,
  type StudioPrefill,
} from "@/lib/creative/studio";

export const FEED_POLL_MS = 5000;
const FEED_SHOWN = 20;

/**
 * The organization's newest generations (GET /api/creative/jobs, RLS:
 * members). Polls every few seconds only while one of them is still working,
 * and stops when none is. A job that ended without a result keeps its card
 * until it is dismissed (on this device); its held credits were already
 * returned by the database.
 */
export function JobFeed({
  orgId,
  models = [],
  refreshKey = 0,
  onRetry,
}: {
  orgId: string;
  models?: StudioModel[];
  /** Bumped by the panel after a job is created: reload now. */
  refreshKey?: number;
  onRetry?: (prefill: StudioPrefill) => void;
}) {
  const { t, locale } = useI18n();
  const path = useChannelPath();
  const [jobs, setJobs] = useState<StudioJob[] | null>(null);
  const [state, setState] = useState<"ok" | "failed" | "unavailable">("ok");
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<{ id: string; code: CreativeError } | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await fetch(`/api/creative/jobs?org_id=${encodeURIComponent(orgId)}`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { jobs?: unknown; error?: unknown };
      if (mine !== seq.current) return;
      if (res.ok) {
        setJobs(coerceJobs(body.jobs));
        setState("ok");
      } else {
        setState(body.error === "creative_unavailable" ? "unavailable" : "failed");
        setJobs((j) => j ?? []);
      }
    } catch {
      if (mine !== seq.current) return;
      setState("failed");
      setJobs((j) => j ?? []);
    }
  }, [orgId]);

  useEffect(() => {
    setDismissed(readDismissed());
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const active = state !== "unavailable" && (jobs ?? []).some((j) => isActiveStatus(j.status));
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => void load(), FEED_POLL_MS);
    return () => clearInterval(id);
  }, [active, load]);

  async function cancel(id: string) {
    setCancelling(id);
    setCancelError(null);
    try {
      const res = await fetch(`/api/creative/jobs/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        setCancelError({ id, code: asCreativeError(body.error) });
      }
    } catch {
      setCancelError({ id, code: "failed" });
    } finally {
      setCancelling(null);
      void load();
    }
  }

  const names = new Map(models.map((m) => [m.id, m.displayName]));
  const shown = (jobs ?? []).filter((j) => !dismissed.includes(j.id)).slice(0, FEED_SHOWN);
  const btn = "btn-sky is-quiet pill min-h-[36px] px-4 py-1.5 text-[12px]";

  return (
    <section className="panel flex flex-col gap-3 p-4" aria-labelledby="gen-feed-title">
      <h2 id="gen-feed-title" className="t-section">
        {t.gen.feedTitle}
      </h2>

      {state === "unavailable" ? (
        <p className="text-[13px] text-[var(--color-muted)]">{t.gen.unavailable}</p>
      ) : (
        <>
          {state === "failed" && <p className="text-[12px] text-[var(--color-warn)]">{t.gen.loadFailed}</p>}
          {jobs !== null && shown.length === 0 && state === "ok" && (
            <p className="text-[13px] text-[var(--color-muted)]">{t.gen.empty}</p>
          )}
          {shown.length > 0 && (
            <ul className="flex flex-col gap-2">
              {shown.map((job) => {
                const sv = statusView(t, job.status);
                const prompt = typeof job.params.prompt === "string" ? job.params.prompt : "";
                const href = job.status === "completed" ? resultHref(job) : null;
                const retry = isUnsuccessful(job.status) ? prefillFromJob(job) : null;
                return (
                  <li
                    key={job.id}
                    className="flex flex-col gap-2 rounded-[14px] border border-[var(--color-border)] p-3"
                    data-status={job.status}
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-[13px] font-semibold text-[var(--color-fg)]">{kindLabel(t, job.capability)}</span>
                      <span className="min-w-0 truncate text-[12px] text-[var(--color-muted)]">
                        {names.get(job.requested_model) ?? job.requested_model}
                      </span>
                      <span className="ml-auto">
                        <StatusPill tone={sv.tone} label={sv.label} live={sv.live} />
                      </span>
                    </div>
                    {prompt && <p className="break-words text-[13px] text-[var(--color-fg)]">{truncate(prompt)}</p>}
                    <p className="mono text-[11px] text-[var(--color-muted)]">{creditsLine(t, job, locale)}</p>
                    {isUnsuccessful(job.status) && (
                      <p className="text-[12px] text-[var(--color-muted)]">
                        {failureReason(t, job)} {t.gen.returnedNote}
                      </p>
                    )}
                    {cancelError?.id === job.id && (
                      <p className="text-[12px] text-[var(--color-fail)]">{apiErrorMessage(t, cancelError.code)}</p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {job.status === "queued" && (
                        <button
                          type="button"
                          className={btn}
                          disabled={cancelling === job.id}
                          onClick={() => void cancel(job.id)}
                        >
                          {cancelling === job.id ? t.gen.cancelling : t.gen.cancel}
                        </button>
                      )}
                      {job.status === "completed" &&
                        (href ? (
                          <a href={href} target="_blank" rel="noopener noreferrer" className={btn}>
                            {t.gen.open}
                          </a>
                        ) : (
                          <Link href={path("/library")} className={btn}>
                            {t.gen.openLibrary}
                          </Link>
                        ))}
                      {retry && onRetry && (
                        <button type="button" className={btn} onClick={() => onRetry(retry)}>
                          {t.gen.tryAgain}
                        </button>
                      )}
                      {isUnsuccessful(job.status) && (
                        <button
                          type="button"
                          className={btn}
                          onClick={() => setDismissed(addDismissed(job.id, dismissed))}
                        >
                          {t.gen.dismiss}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
