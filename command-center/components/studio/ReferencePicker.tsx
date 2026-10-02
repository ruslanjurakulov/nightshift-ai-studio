"use client";

import Link from "next/link";
import { ImageOff, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useLibraryImages, type PickerImage } from "@/components/studio/useLibraryImages";
import { Chip } from "@/components/ui/Chip";
import { ContactSheet, Frame } from "@/components/ui/ContactSheet";
import { Panel } from "@/components/ui/Panel";

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

  const short = selected.length < min;

  return (
    <Panel tone="sunken" as="div" className={`ns-dropzone${selected.length > 0 ? " ns-dropzone-filled" : ""}`}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span aria-live="polite" className="inline-flex items-center gap-2">
            <Chip plain tone={short ? "warn" : "lit"} count={selected.length}>
              {ts.referencesLabel}
            </Chip>
            <span className="sr-only">{fmt(ts.selected, { n: selected.length })}</span>
            <span className="ns-tc text-[12px] text-[var(--color-muted)]" aria-hidden>
              {min}–{max}
            </span>
          </span>
          <span className="text-[12px] text-[var(--color-muted)]">{fmt(ts.refsHint, { min, max })}</span>
        </div>

        {/* The order is the order of use: the first is the cover. */}
        {selected.length > 0 && (
          <ol className="flex gap-2 overflow-x-auto pb-1" aria-label={ts.referencesLabel}>
            {selected.map((id, i) => {
              const img = byId.get(id);
              return (
                <li
                  key={id}
                  className="relative size-20 shrink-0 overflow-hidden rounded-[var(--ns-r-frame)] border-2 border-[var(--ns-amber)] bg-[var(--ns-film)]"
                >
                  {img?.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img.thumbUrl} alt={img.name ?? ""} className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <span className="grid h-full w-full place-items-center text-[var(--ns-on-film)]">
                      <ImageOff aria-hidden className="size-4" />
                    </span>
                  )}
                  <span className="ns-edge-no absolute bottom-0 left-0 bg-[var(--ns-film)] px-1.5 font-mono text-[10px] text-[var(--ns-edge-print)]">
                    {i + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggle(id)}
                    aria-label={fmt(ts.removeRef, { n: i + 1 })}
                    className="absolute right-0 top-0 grid size-7 place-items-center rounded-bl-[var(--ns-r-key)] bg-[var(--ns-film)] text-[var(--ns-on-film)] max-sm:size-11 pointer-coarse:size-11"
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
          <ContactSheet label={ts.pickerLoading} min={96}>
            {Array.from({ length: 8 }).map((_, i) => (
              <Frame key={i} aspect="1 / 1" aria-busy="true">
                <div className="h-full w-full animate-pulse bg-[color-mix(in_srgb,var(--ns-on-film)_12%,var(--ns-film))]" />
              </Frame>
            ))}
          </ContactSheet>
        )}

        {state === "failed" && (
          <div className="flex flex-wrap items-center gap-3 text-[13px] text-[var(--color-muted)]">
            <span>{ts.pickerFailed}</span>
            <button type="button" onClick={() => void load()} className="btn-quiet disabled:opacity-50">
              {ts.retry}
            </button>
          </div>
        )}

        {state === "unavailable" && <p className="text-[13px] text-[var(--color-muted)]">{ts.pickerUnavailable}</p>}

        {state === "ready" && images.length === 0 && (
          <div className="flex flex-wrap items-center gap-3 text-[13px] text-[var(--color-muted)]">
            <span>{ts.pickerEmpty}</span>
            <Link href={libraryHref} className="btn-quiet">
              {ts.pickerOpenLibrary}
            </Link>
          </div>
        )}

        {state === "ready" && images.length > 0 && (
          <ContactSheet label={ts.referencesLabel} min={96}>
            {images.map((img) => {
              const index = selected.indexOf(img.id);
              const on = index >= 0;
              const disabled = !on && full;
              return (
                <Frame key={img.id} aspect="1 / 1" selected={on} number={on ? index + 1 : null} strip>
                  <button
                    type="button"
                    onClick={() => toggle(img.id)}
                    disabled={disabled}
                    aria-pressed={on}
                    aria-label={img.name ?? ts.referencesLabel}
                    className="absolute inset-0 block h-full w-full outline-none transition-opacity focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ns-cue)] disabled:opacity-40"
                  >
                    {img.thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={img.thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <span className="grid h-full w-full place-items-center gap-1 text-[10px] text-[var(--ns-on-film)]">
                        <ImageOff aria-hidden className="size-4" />
                        {ts.noPreview}
                      </span>
                    )}
                  </button>
                </Frame>
              );
            })}
          </ContactSheet>
        )}
      </div>
    </Panel>
  );
}
