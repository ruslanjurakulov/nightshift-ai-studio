"use client";

import Link from "next/link";
import { ImageOff, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useLibraryImages, type PickerImage } from "@/components/studio/useLibraryImages";

export type { PickerImage };

/**
 * Pick reference images from the organization's library, in order.
 *
 * Reads the library through useLibraryImages (GET /api/media under the
 * member's session) and offers the images only. It is deliberately its own
 * small component and does not depend on the library page's components.
 * The selection is only a list of ids; save_style_kit / save_character check
 * every one again in the database.
 *
 * `known` carries tiles for ids already selected that may not be among the
 * library's latest page (an old kit's first reference), so the selected strip
 * can always draw them.
 */
export function ReferencePicker({
  orgId,
  selected,
  onChange,
  min,
  max,
  known,
  libraryHref,
}: {
  orgId: string;
  selected: string[];
  onChange: (next: string[]) => void;
  min: number;
  max: number;
  known: PickerImage[];
  libraryHref: string;
}) {
  const { t } = useI18n();
  const ts = t.styleKits;
  const { state, images, reload: load } = useLibraryImages(orgId);

  const full = selected.length >= max;
  const byId = new Map<string, PickerImage>();
  for (const k of known) byId.set(k.id, k);
  for (const i of images) byId.set(i.id, i);

  function toggle(id: string) {
    if (selected.includes(id)) onChange(selected.filter((s) => s !== id));
    else if (!full) onChange([...selected, id]);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[12px] text-[var(--color-muted)]">{fmt(ts.refsHint, { min, max })}</span>
        <span
          className="mono text-[12px]"
          style={{ color: selected.length < min ? "var(--color-warn)" : "var(--color-fg)" }}
          aria-live="polite"
        >
          {fmt(ts.selected, { n: selected.length })} · {min}–{max}
        </span>
      </div>

      {/* The order is the order of use: the first is the cover. */}
      {selected.length > 0 && (
        <ol className="flex gap-2 overflow-x-auto pb-1" aria-label={ts.referencesLabel}>
          {selected.map((id, i) => {
            const img = byId.get(id);
            return (
              <li key={id} className="relative size-16 shrink-0 overflow-hidden rounded-lg border border-[var(--color-primary)] bg-[var(--color-panel-2)]">
                {img?.thumbUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={img.thumbUrl} alt={img.name ?? ""} className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <span className="grid h-full w-full place-items-center text-[var(--color-muted)]">
                    <ImageOff aria-hidden className="size-4" />
                  </span>
                )}
                <span className="mono absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">{i + 1}</span>
                <button
                  type="button"
                  onClick={() => toggle(id)}
                  aria-label={fmt(ts.removeRef, { n: i + 1 })}
                  className="absolute right-0.5 top-0.5 grid size-6 place-items-center rounded-full bg-black/60 text-white"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {full && state === "ready" && <p className="text-[12px] text-[var(--color-muted)]">{ts.pickerFull}</p>}

      {state === "loading" && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-busy="true" aria-label={ts.pickerLoading}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="aspect-square animate-pulse rounded-lg bg-[var(--color-panel-2)]" />
          ))}
        </div>
      )}

      {state === "failed" && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-border)] p-3 text-[13px] text-[var(--color-muted)]">
          <span>{ts.pickerFailed}</span>
          <button type="button" onClick={() => void load()} className="disabled:opacity-50 btn-sky is-quiet pill px-3 py-1.5 text-[12px]">
            {ts.retry}
          </button>
        </div>
      )}

      {state === "unavailable" && (
        <p className="rounded-lg border border-[var(--color-border)] p-3 text-[13px] text-[var(--color-muted)]">{ts.pickerUnavailable}</p>
      )}

      {state === "ready" && images.length === 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-[var(--color-border)] p-3 text-[13px] text-[var(--color-muted)]">
          <span>{ts.pickerEmpty}</span>
          <Link href={libraryHref} className="disabled:opacity-50 btn-sky is-quiet pill px-3 py-1.5 text-[12px]">
            {ts.pickerOpenLibrary}
          </Link>
        </div>
      )}

      {state === "ready" && images.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {images.map((img) => {
            const index = selected.indexOf(img.id);
            const on = index >= 0;
            const disabled = !on && full;
            return (
              <li key={img.id}>
                <button
                  type="button"
                  onClick={() => toggle(img.id)}
                  disabled={disabled}
                  aria-pressed={on}
                  aria-label={img.name ?? ts.referencesLabel}
                  className="relative block aspect-square w-full overflow-hidden rounded-lg border bg-[var(--color-panel-2)] transition-opacity disabled:opacity-40"
                  style={{ borderColor: on ? "var(--color-primary)" : "var(--color-border)", borderWidth: on ? 2 : 1 }}
                >
                  {img.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img.thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <span className="grid h-full w-full place-items-center gap-1 text-[10px] text-[var(--color-muted)]">
                      <ImageOff aria-hidden className="size-4" />
                      {ts.noPreview}
                    </span>
                  )}
                  {on && (
                    <span
                      className="mono absolute right-1 top-1 grid size-6 place-items-center rounded-full text-[11px] font-semibold text-white"
                      style={{ background: "var(--color-primary)" }}
                    >
                      {index + 1}
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
