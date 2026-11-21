"use client";

import { Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { MIN_REGION_PX, NAME_MAX, PROMPT_MAX, type EditorRegion, type Rect } from "@/lib/regionEdit/geometry";

/**
 * One region's fields: its own name and its own words, and its position and size as plain numbers. The numbers are
 * the keyboard-and-screen-reader way to place a region exactly (the canvas answers a pointer and, when focused, the
 * keyboard too). Every control is at least 44 px tall; nothing here needs a pointer.
 */
export function RegionFields({
  region,
  selected,
  imageSize,
  disabled,
  onSelect,
  onName,
  onPrompt,
  onRect,
  onRemove,
}: {
  region: EditorRegion;
  selected: boolean;
  imageSize: { width: number; height: number };
  disabled: boolean;
  onSelect: () => void;
  onName: (v: string) => void;
  onPrompt: (v: string) => void;
  onRect: (patch: Partial<Rect>) => void;
  onRemove: () => void;
}) {
  const { t, fmt } = useI18n();
  const r = t.regionEdit;
  const id = `region-${region.id}`;
  const numbers: { key: keyof Rect; label: string; max: number }[] = [
    { key: "x", label: r.x, max: imageSize.width - MIN_REGION_PX },
    { key: "y", label: r.y, max: imageSize.height - MIN_REGION_PX },
    { key: "w", label: r.w, max: imageSize.width },
    { key: "h", label: r.h, max: imageSize.height },
  ];
  const noWords = region.prompt.trim() === "";
  return (
    <li
      className={`rounded-[var(--ns-r-panel)] border p-3 ${selected ? "border-[var(--color-primary)]" : "border-[var(--color-border)]"}`}
      data-testid="region-row"
      aria-current={selected ? "true" : undefined}
    >
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={`${id}-name`} className="studio-label">{r.fieldName}</label>
          <div className="studio-field mt-1">
            <input
              id={`${id}-name`}
              value={region.name}
              maxLength={NAME_MAX}
              disabled={disabled}
              onFocus={onSelect}
              onChange={(e) => onName(e.target.value)}
              className="min-h-11 w-full bg-transparent px-3 text-base text-[var(--color-fg)] outline-none sm:text-[14px]"
            />
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={fmt(r.remove, { name: region.name })}
          className="btn-quiet shrink-0 !px-0 size-11"
        >
          <Trash2 aria-hidden className="size-4" />
        </button>
      </div>
      <div className="mt-3">
        <label htmlFor={`${id}-prompt`} className="studio-label">{r.fieldPrompt}</label>
        <div className="studio-field mt-1">
          <textarea
            id={`${id}-prompt`}
            value={region.prompt}
            rows={2}
            maxLength={PROMPT_MAX}
            disabled={disabled}
            onFocus={onSelect}
            onChange={(e) => onPrompt(e.target.value)}
            aria-describedby={`${id}-hint`}
            className="min-h-[88px] w-full resize-none bg-transparent px-3 py-2.5 text-base leading-relaxed text-[var(--color-fg)] outline-none sm:text-[14px]"
          />
        </div>
        <p id={`${id}-hint`} className="mt-1 text-xs text-[var(--color-muted)]">{noWords ? r.skipped : r.promptHint}</p>
      </div>
      <fieldset className="mt-3 min-w-0 border-0 p-0">
        <legend className="studio-label">{r.position}</legend>
        <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {numbers.map(({ key, label, max }) => (
            <div key={key}>
              <label htmlFor={`${id}-${key}`} className="text-xs text-[var(--color-muted)]">{label}</label>
              <div className="studio-field mt-0.5">
                <input
                  id={`${id}-${key}`}
                  type="number"
                  inputMode="numeric"
                  min={key === "w" || key === "h" ? MIN_REGION_PX : 0}
                  max={max}
                  step={1}
                  value={region[key]}
                  disabled={disabled}
                  onFocus={onSelect}
                  onChange={(e) => {
                    const n = e.target.valueAsNumber;
                    if (Number.isFinite(n)) onRect({ [key]: n });
                  }}
                  className="min-h-11 w-full bg-transparent px-3 text-base text-[var(--color-fg)] outline-none sm:text-[14px]"
                />
              </div>
            </div>
          ))}
        </div>
        <p className="mt-1 text-xs text-[var(--color-muted)]">{fmt(r.minNote, { min: MIN_REGION_PX })}</p>
      </fieldset>
    </li>
  );
}
