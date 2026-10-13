"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import type { EditorAsset, EditorExport } from "@/lib/editor";
import {
  canRetry,
  elapsedSeconds,
  formatClock,
  tookSeconds,
} from "@/lib/editorExportStatus";

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
  checking,
  onRetry,
  onCheckNow,
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
  checking: boolean;
  onRetry: () => void | Promise<void>;
  onCheckNow: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const path = useChannelPath();
  const te = t.editor;
  const ep = te.exportPanel;
  const id = useId();
  const retrying = useRef(false);

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

  const retryable = latest.status === "failed" && canRetry(latest.reason);
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
    try {
      await onRetry();
    } finally {
      retrying.current = false;
    }
  }

  return (
    <section
      aria-labelledby={`${id}-h`}
      data-export-state={latest.status}
      className="panel flex min-w-0 flex-col gap-3 p-4 sm:p-5"
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
        {running && failing ? (
          <p className="m-0 break-words text-xs text-[var(--color-warn)]">
            {ep.checkFailed}
          </p>
        ) : null}
      </div>

      {running ? (
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

      {running && failing ? (
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
                type="button"
                onClick={() => void retry()}
                disabled={retryOff}
                aria-describedby={retryWhy ? `${id}-why` : undefined}
                className="btn-primary text-sm"
              >
                {busy && !dirty ? te.exporting : ep.retry}
              </button>
            </div>
          ) : (
            <p className="m-0 break-words text-xs text-[var(--color-muted)]">
              {ep.fixFirst}
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
