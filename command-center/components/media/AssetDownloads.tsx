"use client";

import { useId, useRef, useState } from "react";
import { AlertTriangle, Download, Eye, FileText } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import {
  canRetryDownload,
  downloadRefusal,
  libraryDownloadUrl,
  type DownloadRefusal,
} from "@/lib/libraryDownload";

type Kind = "original" | "captions";

/**
 * "Download original" and "Preview" of one library file, always as two
 * different addresses (lib/libraryDownload.ts), plus "Subtitles (SRT)" where
 * the export had captions.
 *
 * A download is checked before the browser is sent: one ranged byte of the
 * same address, under the same session. A refusal then reads as a sentence
 * here instead of a saved file that holds a JSON error. Reading only: nothing
 * here renders, queues or spends.
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
  const id = useId();
  const busy = useRef<Kind | null>(null);
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
  }

  const btn = compact ? "btn-quiet min-h-11 text-xs" : "btn-quiet min-h-11 text-sm";
  const primary = compact ? "btn-primary min-h-11 text-xs" : "btn-primary min-h-11 text-sm";
  const label = width && height ? fmt(td.originalSize, { w: width, h: height }) : td.original;
  const working = (k: Kind) => state?.kind === k && state.busy;
  const refusal = state && !state.busy ? state.refusal : null;

  return (
    <div className="flex min-w-0 flex-col gap-2" data-asset-downloads={assetId}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${primary} inline-flex items-center gap-1.5`}
          onClick={() => void save("original")}
          disabled={Boolean(state?.busy)}
          aria-busy={working("original")}
          aria-describedby={compact ? undefined : `${id}-o`}
          data-download="original"
        >
          <Download aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 break-words">{working("original") ? td.checking : label}</span>
        </button>
        {preview === "ready" ? (
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`${btn} inline-flex items-center gap-1.5 no-underline`}
            aria-describedby={compact ? undefined : `${id}-p`}
            data-download="preview"
          >
            <Eye aria-hidden className="size-4 shrink-0" />
            {td.preview}
            <span className="sr-only"> {td.newTab}</span>
          </a>
        ) : preview === "missing" ? (
          <button type="button" className={`${btn} inline-flex items-center gap-1.5`} disabled data-download="preview" aria-describedby={compact ? undefined : `${id}-p`}>
            <Eye aria-hidden className="size-4 shrink-0" />
            {td.preview}
          </button>
        ) : null}
        {captions ? (
          <button
            type="button"
            className={`${btn} inline-flex items-center gap-1.5`}
            onClick={() => void save("captions")}
            disabled={Boolean(state?.busy)}
            aria-busy={working("captions")}
            data-download="captions"
          >
            <FileText aria-hidden className="size-4 shrink-0" />
            {working("captions") ? td.checking : td.captions}
          </button>
        ) : null}
      </div>
      {compact ? null : (
        <p className="m-0 break-words text-xs text-[var(--color-muted)]">
          <span id={`${id}-o`}>{td.originalHint}</span>{" "}
          {preview === "none" ? null : <span id={`${id}-p`}>{preview === "ready" ? td.previewHint : td.errors.no_preview}</span>}
        </p>
      )}
      <div role="status" aria-live="polite" className="min-w-0">
        {refusal ? (
          <p className="m-0 flex min-w-0 flex-wrap items-center gap-2 break-words text-xs text-[var(--color-fail)]" data-download-error={refusal}>
            <AlertTriangle aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0">{td.errors[refusal]}</span>
            {canRetryDownload(refusal) && state ? (
              <button type="button" className="btn-quiet min-h-11 text-xs" onClick={() => void save(state.kind)}>
                {td.retry}
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
