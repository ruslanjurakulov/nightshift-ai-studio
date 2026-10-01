"use client";

import { useState } from "react";
import Link from "next/link";
import { ImageOff } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useLibraryImages } from "@/components/studio/useLibraryImages";

/**
 * Pick the ONE library picture an edit, animation, upscale or background
 * removal starts from. Once picked it shows large with "Change picture";
 * the grid comes back only when asked. The pick is only an id: the database
 * refuses (source_unavailable) one that is not a live image of this
 * organization when it prices the job.
 */
export function SourcePicker({
  orgId,
  value,
  onChange,
  libraryHref,
}: {
  orgId: string;
  value: string | null;
  onChange: (id: string) => void;
  libraryHref: string;
}) {
  const { t } = useI18n();
  const g = t.gen;
  const { state, images, reload } = useLibraryImages(orgId);
  const [browsing, setBrowsing] = useState(false);
  const chosen = value ? images.find((i) => i.id === value) : undefined;

  if (value && !browsing) {
    return (
      <div className="flex items-center gap-3">
        <div className="relative size-20 shrink-0 overflow-hidden rounded-xl border-2 border-[var(--color-primary)] bg-[var(--color-panel-2)]">
          {chosen?.thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={chosen.thumbUrl} alt={chosen.name ?? g.sourceChosen} className="h-full w-full object-cover" />
          ) : (
            <span className="grid h-full w-full place-items-center text-[var(--color-muted)]">
              <ImageOff aria-hidden className="size-5" />
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="truncate text-[13px]">{chosen?.name ?? g.sourceChosen}</span>
          <button
            type="button"
            onClick={() => setBrowsing(true)}
            className="btn-sky is-quiet pill w-fit px-3 py-1.5 text-[12px]"
          >
            {g.sourceChange}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[12px] text-[var(--color-muted)]">{g.sourcePick}</span>

      {state === "loading" && (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6" aria-busy="true" aria-label={g.sourceLoading}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="aspect-square animate-pulse rounded-lg bg-[var(--color-panel-2)]" />
          ))}
        </div>
      )}

      {state === "failed" && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-border)] p-3 text-[13px] text-[var(--color-muted)]">
          <span>{g.sourceFailed}</span>
          <button type="button" onClick={() => void reload()} className="btn-sky is-quiet pill px-3 py-1.5 text-[12px]">
            {g.sourceRetry}
          </button>
        </div>
      )}

      {state === "unavailable" && (
        <p className="rounded-lg border border-[var(--color-border)] p-3 text-[13px] text-[var(--color-muted)]">{g.sourceUnavailable}</p>
      )}

      {state === "ready" && images.length === 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-[var(--color-border)] p-3 text-[13px] text-[var(--color-muted)]">
          <span>{g.sourceEmpty}</span>
          <Link href={libraryHref} className="btn-sky is-quiet pill px-3 py-1.5 text-[12px]">
            {g.sourceOpenLibrary}
          </Link>
        </div>
      )}

      {state === "ready" && images.length > 0 && (
        <ul className="grid max-h-[260px] grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6" role="radiogroup" aria-label={g.sourceLabel}>
          {images.map((img) => {
            const on = img.id === value;
            return (
              <li key={img.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={img.name ?? g.sourceLabel}
                  onClick={() => {
                    onChange(img.id);
                    setBrowsing(false);
                  }}
                  className="relative block aspect-square w-full overflow-hidden rounded-lg border bg-[var(--color-panel-2)]"
                  style={{ borderColor: on ? "var(--color-primary)" : "var(--color-border)", borderWidth: on ? 2 : 1 }}
                >
                  {img.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img.thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <span className="grid h-full w-full place-items-center gap-1 text-[10px] text-[var(--color-muted)]">
                      <ImageOff aria-hidden className="size-4" />
                      {g.noPreview}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
