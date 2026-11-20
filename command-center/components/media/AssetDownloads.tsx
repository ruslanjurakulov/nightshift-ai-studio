"use client";

import { useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { AlertTriangle, Download, Eye, FileText, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import {
  canRetryDownload,
  downloadRefusal,
  libraryDownloadUrl,
  type DownloadRefusal,
} from "@/lib/libraryDownload";

type Kind = "original" | "captions";

/** A key that cannot be pressed reads as one: the shared button classes have no disabled look of their own. */
const OFF = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * "Download original" and "Preview" of one library file, always as two
 * different addresses (lib/libraryDownload.ts), plus "Subtitles (SRT)" where
 * the export had captions.
 *
 * A download (original, SRT) is checked before the browser is sent: one
 * ranged byte of the same address, under the same session. A refusal then
 * reads as a sentence here instead of a saved file that holds a JSON error.
 * Preview is a plain link opened in a new tab (a check before it would make
 * the browser block the tab as a pop-up); a refusal there is a short page in
 * the reader's language from the route itself.
 *
 * While a check runs the keys are aria-disabled, not disabled: a disabled key
 * drops the keyboard to <body>, out of the Library's dialog. Reading only:
 * nothing here renders, queues or spends.
 */
export function AssetDownloads({
  assetId,
  preview,
  captions = false,
  width = null,
  height = null,
  compact = false,
}: {
  assetId: string;
  /** "ready": the preview copy exists (a video's 480p proxy). "missing": it should exist and does not, so the button is
   *  shown disabled and says so. "none": this kind of file has no separate preview; no button. */
  preview: "ready" | "missing" | "none";
  /** Offer the SRT of the export's captions. */
  captions?: boolean;
  width?: number | null;
  height?: number | null;
  /** Smaller buttons, for a card. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const td = t.assetDownload;
  const here = usePathname();
  const id = useId();
  const busy = useRef<Kind | null>(null);
  const keys = { original: useRef<HTMLButtonElement>(null), captions: useRef<HTMLButtonElement>(null) };
  const [state, setState] = useState<{ kind: Kind; busy: boolean; refusal: DownloadRefusal | null } | null>(null);

  const originalUrl = libraryDownloadUrl(assetId, "original");
  const previewUrl = libraryDownloadUrl(assetId, "preview");
  const captionsUrl = libraryDownloadUrl(assetId, "captions");
  if (!originalUrl || !previewUrl || !captionsUrl) return null;

  async function save(kind: Kind) {
    const url = kind === "original" ? originalUrl : captionsUrl;
    // A second press before the first answer must not start a second download.
    if (busy.current || !url) return;
    busy.current = kind;
    setState({ kind, busy: true, refusal: null });
    let refusal: DownloadRefusal | null = null;
    try {
      const res = await fetch(url, { headers: { Range: "bytes=0-0" }, cache: "no-store", credentials: "same-origin" });
      if (res.ok) {
        await res.body?.cancel().catch(() => {});
        const a = document.createElement("a");
        a.href = url;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        refusal = downloadRefusal(res.status, body.error);
      }
    } catch {
      refusal = "failed";
    } finally {
      busy.current = null;
    }
    setState({ kind, busy: false, refusal });
    // "Try again" may have been the key pressed, and it is gone now: keep the keyboard on the file's own key.
    keys[kind].current?.focus();
  }

  const btn = `${compact ? "btn-quiet min-h-11 text-xs" : "btn-quiet min-h-11 text-sm"} ${OFF}`;
  const primary = `${compact ? "btn-primary min-h-11 text-xs" : "btn-primary min-h-11 text-sm"} ${OFF}`;
  const anyBusy = Boolean(state?.busy);
  const working = (k: Kind) => state?.kind === k && state.busy;
  const refusal = state && !state.busy ? state.refusal : null;
  const which = state?.kind === "captions" ? td.captions : td.original;
  const describe = (suffix: string) => (compact ? undefined : `${id}-${suffix}`);

  return (
    <div className="flex min-w-0 flex-col gap-2" data-asset-downloads={assetId}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          ref={keys.original}
          type="button"
          className={`${primary} inline-flex items-center gap-1.5 max-sm:w-full max-sm:justify-center`}
          onClick={() => void save("original")}
          aria-disabled={anyBusy || undefined}
          aria-busy={working("original")}
          aria-describedby={describe("o")}
          data-download="original"
        >
          {working("original") ? (
            <Loader2 aria-hidden className="size-4 shrink-0 motion-safe:animate-spin" />
          ) : (
            <Download aria-hidden className="size-4 shrink-0" />
          )}
          {/* The label stays while checking (the spinner says it), so the keys beside it do not jump. */}
          <span className="min-w-0 break-words">
            {td.original}
            {width && height ? <span className="whitespace-nowrap"> · {fmt(td.size, { w: width, h: height })}</span> : null}
          </span>
          {working("original") ? <span className="sr-only"> {td.checking}</span> : null}
        </button>
        {preview === "ready" ? (
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`${btn} inline-flex items-center gap-1.5 no-underline`}
            aria-describedby={describe("p")}
            data-download="preview"
          >
            <Eye aria-hidden className="size-4 shrink-0" />
            {td.preview}
            <span className="sr-only"> {td.newTab}</span>
          </a>
        ) : preview === "missing" ? (
          <button
            type="button"
            className={`${btn} inline-flex items-center gap-1.5`}
            aria-disabled
            aria-describedby={`${id}-p`}
            data-download="preview"
          >
            <Eye aria-hidden className="size-4 shrink-0" />
            {td.preview}
          </button>
        ) : null}
        {captions ? (
          <button
            ref={keys.captions}
            type="button"
            className={`${btn} inline-flex items-center gap-1.5`}
            onClick={() => void save("captions")}
            aria-disabled={anyBusy || undefined}
            aria-busy={working("captions")}
            data-download="captions"
          >
            {working("captions") ? (
              <Loader2 aria-hidden className="size-4 shrink-0 motion-safe:animate-spin" />
            ) : (
              <FileText aria-hidden className="size-4 shrink-0" />
            )}
            {td.captions}
            {working("captions") ? <span className="sr-only"> {td.checking}</span> : null}
          </button>
        ) : null}
      </div>
      {compact ? (
        preview === "missing" ? (
          <span id={`${id}-p`} className="sr-only">
            {td.errors.no_preview}
          </span>
        ) : null
      ) : (
        <p className="m-0 break-words text-xs text-[var(--color-muted)]">
          <span id={`${id}-o`}>{td.originalHint}</span>{" "}
          {preview === "none" ? null : (
            <span id={`${id}-p`}>{preview === "ready" ? td.previewHint : td.errors.no_preview}</span>
          )}
        </p>
      )}
      <div role="status" aria-live="polite" className="min-w-0">
        {refusal ? (
          <div className="flex min-w-0 flex-col items-start gap-2" data-download-error={refusal}>
            <p className="m-0 flex min-w-0 items-start gap-2 break-words text-xs text-[var(--color-fail)]">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0">
                <span className="font-semibold">{which}:</span> {td.errors[refusal]}
              </span>
            </p>
            {canRetryDownload(refusal) && state ? (
              <button type="button" className={`${btn}`} onClick={() => void save(state.kind)}>
                {td.retry}
              </button>
            ) : refusal === "unauthorized" ? (
              <a className={`${btn} no-underline`} href={`/login?next=${encodeURIComponent(here || "/")}`}>
                {td.signIn}
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
