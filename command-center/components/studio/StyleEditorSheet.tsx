"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import {
  CHARACTER_LIMITS,
  KIT_LIMITS,
  charLength,
  cleanKitName,
  isCharacterName,
  normalizeCharacterName,
  type Character,
  type CharacterKind,
  type StyleKit,
} from "@/lib/style-kits";
import { ReferencePicker, type PickerImage } from "@/components/studio/ReferencePicker";

export type EditorTarget =
  | { mode: "kit"; item: StyleKit | null }
  | { mode: "character"; item: Character | null };

const inputClass =
  "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-base text-[var(--color-fg)] outline-none focus-visible:border-[var(--color-primary)] sm:text-[13px]";

/**
 * Create or edit one style kit or character, in a sheet: a bottom sheet on a
 * phone, a centred dialog from `sm` up.
 *
 * The form checks the same limits the database does (lib/style-kits.ts) so
 * Save is only enabled for something that can be saved; the database still
 * decides, and its refusal is shown in words. References that were deleted
 * from the library since the last save are dropped from the selection on
 * open — a save naming them would be refused.
 */
export function StyleEditorSheet({
  target,
  orgId,
  libraryHref,
  onClose,
  onSaved,
}: {
  target: EditorTarget;
  orgId: string;
  libraryHref: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const ts = t.styleKits;
  const titleId = useId();
  const firstField = useRef<HTMLInputElement>(null);
  const isKit = target.mode === "kit";
  const limits = isKit ? KIT_LIMITS : CHARACTER_LIMITS;
  const item = target.item;

  const [name, setName] = useState(item ? (isKit ? item.name : `@${item.name}`) : "");
  const [kind, setKind] = useState<CharacterKind>(target.mode === "character" && target.item ? target.item.kind : "character");
  const [description, setDescription] = useState(item?.description ?? "");
  const [selected, setSelected] = useState<string[]>(() => (item ? item.references.filter((r) => r.live).map((r) => r.assetId) : []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const known: PickerImage[] = (item?.references ?? []).filter((r) => r.live).map((r) => ({ id: r.assetId, thumbUrl: r.thumbUrl, name: null }));

  const cleanName = isKit ? cleanKitName(name) : normalizeCharacterName(name);
  const nameOk = isKit ? charLength(cleanName) >= 1 && charLength(cleanName) <= KIT_LIMITS.nameMax : isCharacterName(cleanName);
  const descLength = charLength(description);
  const descOk = descLength <= limits.descriptionMax;
  const refsOk = selected.length >= limits.minRefs && selected.length <= limits.maxRefs;
  const canSave = nameOk && descOk && refsOk && !saving;

  useEffect(() => {
    firstField.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  function errorText(word: unknown): string {
    const e = ts.errors;
    switch (word) {
      case "invalid_name":
        return isKit ? fmt(e.invalid_kit_name, { max: KIT_LIMITS.nameMax }) : e.invalid_char_name;
      case "invalid_description":
        return fmt(e.invalid_description, { max: limits.descriptionMax });
      case "too_few_references":
        return fmt(e.too_few_references, { min: limits.minRefs });
      case "too_many_references":
        return fmt(e.too_many_references, { max: limits.maxRefs });
      case "limit_reached":
        return fmt(e.limit_reached, { max: limits.perOrg });
      case "bad_request":
      case "invalid_kind":
      case "duplicate_reference":
      case "invalid_reference":
      case "name_taken":
      case "forbidden":
      case "not_found":
      case "unauthorized":
      case "not_available":
        return e[word];
      default:
        return e.failed;
    }
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const base = isKit ? "/api/style-kits" : "/api/characters";
    const payload = isKit
      ? { org_id: orgId, name: cleanName, description, asset_ids: selected }
      : { org_id: orgId, name: cleanName, kind, description, asset_ids: selected };
    try {
      const res = await fetch(item ? `${base}/${item.id}` : base, {
        method: item ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        setError(errorText(body.error));
        setSaving(false);
        return;
      }
      setSaving(false);
      onSaved();
    } catch {
      setError(ts.errors.failed);
      setSaving(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape" && !saving) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  if (typeof document === "undefined") return null;

  const title = isKit ? (item ? ts.editKit : ts.newKit) : item ? ts.editChar : ts.newChar;

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-end justify-center sm:items-center sm:p-4" onKeyDown={onKeyDown}>
      <div aria-hidden className="scrim-enter absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={() => !saving && onClose()} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="sheet-enter relative flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-[var(--shadow-elevated)] sm:max-w-2xl sm:rounded-[var(--ns-r-key)]"
      >
        <header className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
          <h2 id={titleId} className="text-[15px] font-semibold text-[var(--color-fg)]">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label={ts.close}
            className="grid size-9 place-items-center rounded-[var(--ns-r-key)] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
          >
            <X aria-hidden className="size-5" />
          </button>
        </header>

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--color-muted)]">{isKit ? ts.nameLabel : ts.handleLabel}</span>
              <input
                ref={firstField}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={isKit ? ts.namePlaceholder : `@${ts.handlePlaceholder}`}
                maxLength={isKit ? KIT_LIMITS.nameMax + 10 : CHARACTER_LIMITS.nameMax + 2}
                autoCapitalize={isKit ? "sentences" : "none"}
                autoCorrect={isKit ? "on" : "off"}
                spellCheck={isKit}
                aria-invalid={name !== "" && !nameOk}
                className={`${inputClass} ${isKit ? "" : "tnum"}`}
              />
              {!isKit && (
                <span className="text-xs" style={{ color: name !== "" && !nameOk ? "var(--color-warn)" : "var(--color-muted)" }}>
                  {ts.handleHint}
                </span>
              )}
            </label>

            {!isKit && (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1.5 text-xs font-medium text-[var(--color-muted)]">{ts.kindLabel}</legend>
                <div className="flex gap-2">
                  {(["character", "product"] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setKind(k)}
                      aria-pressed={kind === k}
                      className={`disabled:opacity-50 ${kind === k ? "btn-primary" : "btn-quiet"}`}
                    >
                      {k === "character" ? ts.kindCharacter : ts.kindProduct}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}

            <label className="flex flex-col gap-1.5">
              <span className="flex items-baseline justify-between gap-2 text-xs font-medium text-[var(--color-muted)]">
                <span>{ts.descriptionLabel}</span>
                <span className="tnum text-xs" style={{ color: descOk ? "var(--color-muted)" : "var(--color-warn)" }}>
                  {fmt(ts.counter, { n: descLength, max: limits.descriptionMax })}
                </span>
              </span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder={isKit ? ts.kitDescriptionPlaceholder : ts.charDescriptionPlaceholder}
                aria-invalid={!descOk}
                className={inputClass}
              />
            </label>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--color-muted)]">{ts.referencesLabel}</span>
              <ReferencePicker
                orgId={orgId}
                selected={selected}
                onChange={setSelected}
                min={limits.minRefs}
                max={limits.maxRefs}
                known={known}
                libraryHref={libraryHref}
              />
            </div>
          </div>

          <footer className="flex flex-col gap-2 border-t border-[var(--color-border)] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {error && (
              <p role="alert" className="text-sm" style={{ color: "var(--color-fail)" }}>
                {error}
              </p>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" onClick={onClose} disabled={saving} className="disabled:opacity-50 btn-quiet text-sm">
                {ts.cancel}
              </button>
              <button type="submit" disabled={!canSave} aria-busy={saving} className="disabled:opacity-50 btn-primary text-sm">
                {saving ? ts.saving : ts.save}
              </button>
            </div>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}
