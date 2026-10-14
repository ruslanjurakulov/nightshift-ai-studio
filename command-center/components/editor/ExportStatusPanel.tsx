"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import type { EditorAsset, EditorError, EditorExport } from "@/lib/editor";
import {
  elapsedSeconds,
  formatClock,
  retryPlan,
  tookSeconds,
} from "@/lib/editorExportStatus";
import type { PollHalt } from "./useExportPoll";

/** A second-by-second clock, only while an export runs and only after mount (the server cannot know the time). */
function useNow(on: boolean): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!on) return;
    const first = setTimeout(() => setNow(Date.now()), 0);
    const every = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [on]);
  return now;
}

const libraryLink =
  "inline-flex min-h-11 items-center justify-center rounded-[var(--ns-r-key)] border border-[var(--color-border)] px-4 text-sm font-medium text-[var(--color-primary)] no-underline hover:bg-[var(--color-hover)]";

/**
 * Where the latest export of this project stands, in words: waiting, rendering
 * (how long it has been going; the time left is said to be unknown because the
 * worker reports no progress), ready (open the video) or failed (a plain
 * sentence and one retry). It only reads the export rows the editor already
 * has and asks the editor to start the same export the Export button starts;
 * it renders, charges and publishes nothing.
 *
 * Screen readers: one polite region that changes only when the state does;
 * the ticking clock sits outside it, so it is never read out every second.
 */
export function ExportStatusPanel({
  latest,
  assets,
  currentRev,
  dirty,
  busy,
  failing,
  halt,
  checking,
  onRetry,
  onCheckNow,
  quietRetry = false,
}: {
  /** The newest export of the project. */
  latest: EditorExport;
  assets: Record<string, EditorAsset>;
  /** The saved revision a retry would export. */
  currentRev: number;
  /** Unsaved changes: nothing can be exported until they are saved. */
  dirty: boolean;
  /** An export is being started or is already on its way. */
  busy: boolean;
  /** Status checks keep failing. */
  failing: boolean;
  /** Checks have stopped for good: signed out, or the project is gone. */
  halt: PollHalt | null;
  checking: boolean;
  /** Starts the export again; answers the refusal word, or null when it started. */
  onRetry: () => Promise<EditorError | null> | void;
  onCheckNow: () => void | Promise<void>;
  /** The draft banner is showing and its "Restore changes" is the one primary
   *  action on the screen: "Try again" steps back to a quiet button. */
  quietRetry?: boolean;
}) {
  const { t } = useI18n();
  const path = useChannelPath();
  const te = t.editor;
  const ep = te.exportPanel;
  const id = useId();
  const retrying = useRef(false);
  const section = useRef<HTMLElement>(null);
  const retryBtn = useRef<HTMLButtonElement>(null);
  const [refused, setRefused] = useState<{ id: string; error: EditorError } | null>(null);

  const running = latest.status === "queued" || latest.status === "rendering";
  const now = useNow(running);
  const elapsed =
    running && now !== null ? elapsedSeconds(latest.createdAt, now) : null;
  const took = !running ? tookSeconds(latest) : null;
  const video = latest.assetId ? assets[latest.assetId] : undefined;

  const Icon =
    latest.status === "done"
      ? CheckCircle2
      : latest.status === "failed"
        ? AlertTriangle
        : latest.status === "rendering"
          ? Loader2
          : Clock;
  const tone =
    latest.status === "done"
      ? "text-[var(--color-ok)]"
      : latest.status === "failed"
        ? "text-[var(--color-fail)]"
        : "text-[var(--color-warn)]";
  const line =
    latest.status === "queued"
      ? ep.queuedLine
      : latest.status === "rendering"
        ? ep.renderingLine
        : latest.status === "done"
          ? ep.doneLine
          : ep.failedLine;

  const plan = latest.status === "failed" ? retryPlan(latest, currentRev) : null;
  const retryable = plan === "retry";
  const retryOff = dirty || busy;
  const retryWhy = !retryable
    ? null
    : dirty
      ? ep.retryNeedsSave
      : latest.rev !== currentRev
        ? fmt(ep.retryOtherVersion, { rev: currentRev })
        : null;

  async function retry() {
    // A second press before the first request has answered must not start a second export.
    if (retrying.current || retryOff) return;
    retrying.current = true;
    setRefused(null);
    try {
      const error = (await onRetry()) ?? null;
      if (error) {
        setRefused({ id: latest.id, error });
      } else {
        // The button is about to give way to the new export: keep the keyboard here.
        section.current?.focus();
      }
    } finally {
      retrying.current = false;
    }
  }
  const refusedWord = refused && refused.id === latest.id ? refused.error : null;
  // After a refusal the button is enabled again: put the keyboard back on it.
  useEffect(() => {
    if (refusedWord) retryBtn.current?.focus();
  }, [refusedWord]);

  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-labelledby={`${id}-h`}
      data-export-state={latest.status}
      className="panel flex min-w-0 flex-col gap-3 p-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] sm:p-5"
    >
      <h2 id={`${id}-h`} className="m-0 text-[15px] font-semibold">
        {ep.latest}
      </h2>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        className="flex min-w-0 flex-col gap-1.5"
      >
        <p className="m-0 flex min-w-0 items-start gap-2 text-sm">
          <Icon
            aria-hidden
            className={`mt-0.5 size-4 shrink-0 ${tone} ${latest.status === "rendering" ? "motion-safe:animate-spin" : ""}`}
          />
          <span className="min-w-0 break-words">
            <span className={`font-semibold ${tone}`}>
              {te.exportStatus[latest.status]}
            </span>
            {" · "}
            <span>{line}</span>
          </span>
        </p>
        {latest.status === "failed" ? (
          <p className="m-0 break-words text-sm text-[var(--color-fail)]">
            {te.exportReasons[latest.reason ?? "other"]}
          </p>
        ) : null}
        {running && halt ? (
          <p className="m-0 break-words text-sm text-[var(--color-fail)]">
            {halt === "unauthorized" ? ep.signedOut : ep.notFound}
          </p>
        ) : running && failing ? (
          <p className="m-0 break-words text-xs text-[var(--color-warn)]">
            {ep.checkFailed}
          </p>
        ) : null}
        {refusedWord ? (
          <p className="m-0 break-words text-sm text-[var(--color-fail)]">
            {te.errors[refusedWord]}
          </p>
        ) : null}
      </div>

      {running && halt ? null : running ? (
        <p className="m-0 break-words text-xs text-[var(--color-muted)]">
          {elapsed !== null ? (
            <>
              <span>{fmt(ep.elapsed, { time: formatClock(elapsed) })}</span>
              {" · "}
            </>
          ) : null}
          <span>{ep.timeLeft}</span>
        </p>
      ) : took !== null ? (
        <p className="m-0 text-xs text-[var(--color-muted)]">
          {fmt(ep.tookLabel, { time: formatClock(took) })}
        </p>
      ) : null}

      {running && failing && !halt ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void onCheckNow()}
            disabled={checking}
            className="btn-quiet min-h-11 text-sm"
          >
            {checking ? ep.checking : ep.checkNow}
          </button>
        </div>
      ) : null}

      {latest.status === "done" ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {video?.viewUrl ? (
            <a
              href={video.viewUrl}
              target="_blank"
              rel="noreferrer"
              className="btn-primary text-sm no-underline"
            >
              {ep.openVideo}
              <span className="sr-only"> {ep.newTab}</span>
            </a>
          ) : (
            <>
              <p className="m-0 min-w-0 break-words text-xs text-[var(--color-muted)]">
                {ep.noLink}
              </p>
              <button
                type="button"
                onClick={() => void onCheckNow()}
                disabled={checking}
                className="btn-quiet min-h-11 text-sm"
              >
                {checking ? ep.checking : ep.getLink}
              </button>
            </>
          )}
          <Link href={path("/library")} className={libraryLink}>
            {te.viewInLibrary}
          </Link>
        </div>
      ) : null}

      {latest.status === "failed" ? (
        <div className="flex min-w-0 flex-col gap-2">
          {retryable ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                ref={retryBtn}
                type="button"
                onClick={() => void retry()}
                disabled={retryOff}
                aria-describedby={retryWhy ? `${id}-why` : undefined}
                className={`${quietRetry ? "btn-quiet" : "btn-primary"} min-h-11 text-sm`}
              >
                {busy && !dirty ? te.exporting : ep.retry}
              </button>
            </div>
          ) : (
            <p className="m-0 break-words text-xs text-[var(--color-muted)]">
              {plan === "deleted" ? ep.deletedLine : fmt(ep.fixFirst, { export: te.export })}
            </p>
          )}
          {retryWhy ? (
            <p
              id={`${id}-why`}
              className="m-0 break-words text-xs text-[var(--color-muted)]"
            >
              {retryWhy}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
