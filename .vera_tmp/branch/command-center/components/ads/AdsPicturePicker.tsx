"use client";

import Link from "next/link";
import { ImageOff } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useLibraryImages } from "@/components/studio/useLibraryImages";

/**
 * Pick up to `max` pictures from the organization's own media library, in order.
 *
 * Reads the library through useLibraryImages (GET /api/media under the member's session) and offers its images only. Nothing is
 * uploaded or fetched from anywhere else here. The selection is only a list of ids: save_brand_kit / save_brand_product check every
 * one again in the database (a live image of the same organization), so a picked id that went stale is refused there, not trusted.
 */
export function AdsPicturePicker({
  orgId,
  selected,
  onChange,
  max,
  label,
  libraryHref,
}: {
  orgId: string;
  selected: string[];
  onChange: (next: string[]) => void;
  max: number;
  label: string;
  libraryHref: string;
}) {
  const { t } = useI18n();
  const tp = t.adsFactory.picker;
  const { state, images, reload } = useLibraryImages(orgId);
  const full = selected.length >= max;

  function toggle(id: string) {
    if (selected.includes(id)) onChange(selected.filter((s) => s !== id));
    // One picture (a logo): picking another replaces it, so there is never a dead end at "full".
    else if (max === 1) onChange([id]);
    else if (!full) onChange([...selected, id]);
  }

  return (
    <div className="ads-picker">
      <p className="ads-small" aria-live="polite">
        {fmt(tp.selected, { n: selected.length, max })}
        {full && max > 1 ? ` ${tp.full}` : ""}
      </p>
      {state === "loading" && <p className="ads-small" role="status">{tp.loading}</p>}
      {state === "failed" && (
        <div className="ads-row">
          <p className="ads-fail">{tp.failed}</p>
          <button type="button" className="btn-quiet min-h-11 px-3 text-sm" onClick={() => void reload()}>
            {t.adsFactory.retry}
          </button>
        </div>
      )}
      {state === "unavailable" && <p className="ads-small">{tp.unavailable}</p>}
      {state === "ready" && images.length === 0 && (
        <div className="ads-row">
          <p className="ads-small">{tp.empty}</p>
          <Link href={libraryHref} className="btn-quiet inline-flex min-h-11 items-center px-3 text-sm">
            {tp.openLibrary}
          </Link>
        </div>
      )}
      {state === "ready" && images.length > 0 && (
        <ul className="ads-picker-grid" aria-label={label}>
          {images.map((img) => {
            const index = selected.indexOf(img.id);
            const on = index >= 0;
            return (
              <li key={img.id}>
                <button
                  type="button"
                  className="ads-pick"
                  aria-pressed={on}
                  data-n={on ? index + 1 : undefined}
                  disabled={!on && full && max > 1}
                  aria-label={fmt(tp.pick, { name: img.name ?? tp.unnamed })}
                  onClick={() => toggle(img.id)}
                >
                  {img.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img.thumbUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="grid h-full w-full place-items-center gap-1">
                      <ImageOff aria-hidden className="size-4" />
                      {tp.noPreview}
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
