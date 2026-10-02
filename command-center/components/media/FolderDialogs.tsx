"use client";

import { useId, useRef, useState, type RefObject } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { FOLDER_NAME_MAX, cleanFolderName, type FolderError } from "@/lib/media-folders";
import { LibraryDialog } from "./LibraryDialog";
import { fileCount } from "./libraryView";

/**
 * Name a new folder, or rename one. The name is checked here only so the
 * button can say what is wrong before a round trip; the database checks it
 * again (length, unique ignoring case, 200 per organization) and its refusal
 * is shown as a sentence, the dialog left open with what was typed.
 */
export function FolderNameDialog({
  mode,
  initialName = "",
  onSubmit,
  onClose,
  opener,
}: {
  mode: "create" | "rename";
  initialName?: string;
  /** Resolves to null when done (the caller closes the dialog), or why not. */
  onSubmit: (name: string) => Promise<FolderError | null>;
  onClose: () => void;
  opener?: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const tf = t.media.folders;
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FolderError | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const clean = cleanFolderName(name);
  const length = [...clean].length;
  const valid = length >= 1 && length <= FOLDER_NAME_MAX;
  const unchanged = mode === "rename" && clean === initialName;

  async function submit() {
    if (!valid || busy) return;
    if (unchanged) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    const why = await onSubmit(clean);
    setBusy(false);
    if (why) {
      setError(why);
      input.current?.focus();
    }
  }

  return (
    <LibraryDialog
      title={mode === "create" ? tf.createTitle : tf.renameTitle}
      onClose={onClose}
      opener={opener}
      initialFocus={input}
      closeLabel={t.media.viewer.close}
      busy={busy}
      testId="folder-name-dialog"
    >
      <form
        id={`${inputId}-form`}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-2 pb-1"
      >
        <label htmlFor={inputId} className="t-label">
          {tf.nameLabel}
        </label>
        <input
          ref={input}
          id={inputId}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          maxLength={FOLDER_NAME_MAX + 20}
          autoComplete="off"
          enterKeyHint="done"
          placeholder={tf.namePlaceholder}
          aria-invalid={error !== null || length > FOLDER_NAME_MAX}
          aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`}
          className="w-full rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2.5 text-[16px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-muted)] focus:border-[var(--color-primary)] sm:text-[14px]"
        />
        <span
          id={hintId}
          className={`mono text-[11px] ${length > FOLDER_NAME_MAX ? "text-[var(--color-fail)]" : "text-[var(--color-muted)]"}`}
        >
          {fmt(tf.nameHint, { n: length, max: FOLDER_NAME_MAX })}
        </span>
        {error && (
          <p id={errorId} role="alert" className="m-0 text-[13px] text-[var(--color-fail)]">
            {tf.errors[error]}
          </p>
        )}
      </form>
      <div className="flex flex-wrap items-center justify-end gap-2 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        <button type="button" onClick={onClose} disabled={busy} className="btn-quiet text-[13px]">
          {tf.cancel}
        </button>
        <button
          type="submit"
          form={`${inputId}-form`}
          disabled={!valid || busy}
          className="btn-primary text-[13px] disabled:opacity-40"
        >
          {mode === "create" ? (busy ? tf.creating : tf.create) : busy ? tf.saving : tf.save}
        </button>
      </div>
    </LibraryDialog>
  );
}

/** "Delete the folder?" — says plainly that the files stay. */
export function DeleteFolderDialog({
  name,
  count,
  onConfirm,
  onClose,
  opener,
}: {
  name: string;
  count: number | null;
  onConfirm: () => Promise<FolderError | null>;
  onClose: () => void;
  opener?: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const tf = t.media.folders;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FolderError | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    const why = await onConfirm();
    setBusy(false);
    if (why) setError(why);
  }

  return (
    <LibraryDialog
      title={fmt(tf.deleteTitle, { name })}
      description={count === null ? tf.deleteBodyUnknown : fmt(tf.deleteBody, { n: count, files: fileCount(tf, count) })}
      onClose={onClose}
      opener={opener}
      // The safe choice has focus: Enter on an open "delete?" must not delete.
      initialFocus={cancel}
      closeLabel={t.media.viewer.close}
      busy={busy}
      testId="folder-delete-dialog"
      footer={
        <>
          {error && (
            <p role="alert" className="m-0 w-full text-[13px] text-[var(--color-fail)]">
              {tf.errors[error]}
            </p>
          )}
          <button ref={cancel} type="button" onClick={onClose} disabled={busy} className="btn-quiet text-[13px]">
            {tf.cancel}
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            className="btn-quiet border-[var(--color-fail)] bg-[var(--color-fail)] font-semibold text-[var(--color-on-accent)] hover:bg-[var(--color-fail)] disabled:opacity-40"
          >
            {busy ? tf.deleting : tf.delete}
          </button>
        </>
      }
    />
  );
}
