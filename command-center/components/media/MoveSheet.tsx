"use client";

import { useId, useRef, useState, type RefObject } from "react";
import { Check, Folder, FolderMinus, FolderPlus } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { FOLDER_NAME_MAX, cleanFolderName, type FolderError, type MediaFolder } from "@/lib/media-folders";
import { LibraryDialog } from "./LibraryDialog";
import { fileCount } from "./libraryView";

/**
 * "Move to…": where the selected files go — a folder, "No folder", or a new
 * folder made for them. One tap moves them (the database checks every file
 * and the folder, all or nothing); a refusal is said here, in a sentence, and
 * nothing has moved.
 *
 * `here` is the folder every selected file is already in (null = all in no
 * folder; undefined = they are in different places): that row is marked and
 * cannot be chosen, since moving there would change nothing.
 */
export function MoveSheet({
  count,
  folders,
  here,
  onMove,
  onCreateAndMove,
  onClose,
  opener,
}: {
  count: number;
  folders: readonly MediaFolder[];
  here: string | null | undefined;
  onMove: (folderId: string | null, name: string | null) => Promise<FolderError | null>;
  onCreateAndMove: (name: string) => Promise<FolderError | null>;
  onClose: () => void;
  opener?: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const tf = t.media.folders;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<FolderError | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const first = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const clean = cleanFolderName(name);
  const nameOk = [...clean].length >= 1 && [...clean].length <= FOLDER_NAME_MAX;

  async function run(key: string, fn: () => Promise<FolderError | null>) {
    if (busy) return;
    setBusy(key);
    setError(null);
    const why = await fn();
    setBusy(null);
    if (why) setError(why);
  }

  const row = (key: string, on: boolean) =>
    `press flex w-full items-center gap-3 rounded-[var(--ns-r-key)] border px-3.5 py-3 text-left ${
      on
        ? "cursor-default border-[var(--color-border)] bg-[var(--color-panel-2)] opacity-70"
        : "border-[var(--color-border)] bg-[var(--color-panel)] hover:border-[var(--color-primary)]"
    } ${busy === key ? "border-[var(--color-primary)]" : ""}`;

  // Focus starts on the first place the files can actually go.
  const firstKey = here !== null ? "none" : (folders.find((f) => f.id !== here)?.id ?? "new");

  return (
    <LibraryDialog
      title={fmt(tf.moveTitle, { n: count, files: fileCount(tf, count) })}
      description={tf.moveHint}
      onClose={onClose}
      opener={opener}
      initialFocus={first}
      closeLabel={t.media.viewer.close}
      busy={busy !== null}
      wide
      testId="move-sheet"
    >
      <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label={tf.rail}>
        <li>
          <button
            ref={firstKey === "none" ? first : undefined}
            type="button"
            disabled={here === null || busy !== null}
            onClick={() => void run("none", () => onMove(null, null))}
            className={row("none", here === null)}
          >
            <FolderMinus className="size-5 shrink-0 text-[var(--color-muted)]" aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[14px] font-medium text-[var(--color-fg)]">{tf.noFolder}</span>
              <span className="text-[12px] text-[var(--color-muted)]">{busy === "none" ? tf.moving : tf.noFolderHint}</span>
            </span>
            {here === null && <HereMark label={tf.here} />}
          </button>
        </li>
        {folders.map((f) => {
          const on = here === f.id;
          return (
            <li key={f.id}>
              <button
                ref={firstKey === f.id ? first : undefined}
                type="button"
                disabled={on || busy !== null}
                onClick={() => void run(f.id, () => onMove(f.id, f.name))}
                className={row(f.id, on)}
              >
                <Folder className="size-5 shrink-0 text-[var(--color-primary)]" aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[14px] font-medium text-[var(--color-fg)]" title={f.name}>
                    {f.name}
                  </span>
                  <span className="text-[12px] text-[var(--color-muted)]">
                    {busy === f.id ? tf.moving : f.count === null ? tf.countUnknown : fileCount(tf, f.count)}
                  </span>
                </span>
                {on && <HereMark label={tf.here} />}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 border-t border-[var(--color-border)] pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        {creating ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (nameOk) void run("new", () => onCreateAndMove(clean));
            }}
          >
            <label htmlFor={inputId} className="t-label">
              {tf.nameLabel}
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                ref={nameInput}
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
                disabled={busy !== null}
                className="min-w-0 flex-[1_1_12rem] rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2.5 text-[16px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-muted)] focus:border-[var(--color-primary)] sm:text-[14px]"
              />
              <button type="submit" disabled={!nameOk || busy !== null} className="btn-primary shrink-0 text-[13px] disabled:opacity-40">
                {busy === "new" ? tf.moving : tf.createAndMove}
              </button>
            </div>
          </form>
        ) : (
          <button
            ref={firstKey === "new" ? first : undefined}
            type="button"
            disabled={busy !== null}
            onClick={() => {
              setCreating(true);
              // After the input exists.
              setTimeout(() => nameInput.current?.focus(), 0);
            }}
            className="press flex w-full items-center gap-3 rounded-[var(--ns-r-key)] border border-dashed border-[var(--color-border)] px-3.5 py-3 text-left text-[14px] font-medium text-[var(--color-fg)] hover:border-[var(--color-primary)]"
          >
            <FolderPlus className="size-5 shrink-0 text-[var(--color-muted)]" aria-hidden />
            {tf.newAndMove}
          </button>
        )}
        {error && (
          <p role="alert" className="m-0 mt-3 text-[13px] text-[var(--color-fail)]">
            {tf.errors[error]}
          </p>
        )}
      </div>
    </LibraryDialog>
  );
}

function HereMark({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-[var(--color-muted)]">
      <Check className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}
