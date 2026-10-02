"use client";

import type { Ref } from "react";
import { Folder, FolderPlus, Images } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import type { MediaFoldersState } from "@/lib/media-folders";
import { fileCount } from "./libraryView";

/**
 * Where the library's files are kept: "All files", then each folder with how
 * many files it holds, then "New folder". A row of chips that scrolls
 * sideways on a phone, a column beside the grid from `lg` up. Choosing one
 * only narrows what the grid shows.
 *
 * "New folder" is there only for someone who may make one (`canCreate`: an
 * editor or more). A viewer reads the folders and opens them; the database
 * would refuse them the rest anyway (0049).
 *
 * A count that could not be read is not shown at all — never as 0.
 */
export function FolderRail({
  state,
  current,
  onSelect,
  onNew,
  allRef,
  newRef,
  disabled = false,
  canCreate = true,
}: {
  state: MediaFoldersState;
  current: string | null;
  onSelect: (id: string | null) => void;
  onNew: () => void;
  allRef?: Ref<HTMLButtonElement>;
  newRef?: Ref<HTMLButtonElement>;
  disabled?: boolean;
  canCreate?: boolean;
}) {
  const { t } = useI18n();
  const tf = t.media.folders;
  // Outlines are rings, not borders: the global `* { border-color }` rule in
  // globals.css is unlayered and would win over any border-colour utility.
  const item = (on: boolean) =>
    `press flex shrink-0 items-center gap-2 rounded-[var(--ns-r-key)] px-3.5 py-2 text-left text-[13px] font-medium ring-inset lg:w-full lg:rounded-[var(--ns-r-key)] lg:px-3 lg:py-2.5 ${
      on
        ? "bg-[color-mix(in_srgb,var(--color-primary)_14%,var(--color-panel))] text-[var(--color-fg)] ring-1 ring-[var(--color-primary)]"
        : // A chip with an outline on a phone; a quiet row in the column beside the grid.
          "text-[var(--color-fg)] hover:bg-[var(--color-panel-2)] max-lg:bg-[var(--color-panel)] max-lg:ring-1 max-lg:ring-[var(--color-border)] max-lg:hover:ring-[var(--color-primary)]"
    }`;
  const count = (n: number | null, on: boolean) =>
    n === null ? null : (
      <span className={`mono ml-auto pl-1 text-[11px] ${on ? "text-[var(--color-fg)]" : "text-[var(--color-muted)]"}`} aria-hidden>
        {n}
      </span>
    );
  const label = (name: string, n: number | null) => (n === null ? name : `${name}, ${fileCount(tf, n)}`);

  return (
    <nav aria-label={tf.rail} className="min-w-0 lg:sticky lg:top-4 lg:w-60 lg:shrink-0" data-folder-rail>
      <h2 className="t-label mb-2 hidden lg:block">{tf.rail}</h2>
      <ul className="m-0 flex list-none gap-2 overflow-x-auto p-0 pb-1 [scrollbar-width:none] lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0">
        <li className="shrink-0 lg:w-full">
          <button
            ref={allRef}
            type="button"
            disabled={disabled}
            aria-current={current === null ? "true" : undefined}
            aria-label={label(tf.allFiles, state.total)}
            onClick={() => onSelect(null)}
            className={item(current === null)}
          >
            <Images className="size-4 shrink-0 text-[var(--color-muted)]" aria-hidden />
            <span className="whitespace-nowrap">{tf.allFiles}</span>
            {count(state.total, current === null)}
          </button>
        </li>
        {state.folders.map((f) => {
          const on = current === f.id;
          return (
            <li key={f.id} className="min-w-0 shrink-0 lg:w-full" data-folder-id={f.id}>
              <button
                type="button"
                disabled={disabled}
                aria-current={on ? "true" : undefined}
                aria-label={label(f.name, f.count)}
                onClick={() => onSelect(f.id)}
                className={item(on)}
              >
                <Folder className={`size-4 shrink-0 ${on ? "text-[var(--color-primary)]" : "text-[var(--color-muted)]"}`} aria-hidden />
                <span className="max-w-[11rem] truncate lg:max-w-none lg:flex-1" title={f.name}>
                  {f.name}
                </span>
                {count(f.count, on)}
              </button>
            </li>
          );
        })}
        {canCreate && (
          <li className="shrink-0 lg:mt-1 lg:w-full">
            <button
              ref={newRef}
              type="button"
              disabled={disabled}
              onClick={onNew}
              className="press flex items-center gap-2 whitespace-nowrap rounded-[var(--ns-r-key)] border border-dashed border-[var(--color-border)] px-3.5 py-2 text-[13px] font-medium text-[var(--color-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-fg)] lg:w-full lg:rounded-[var(--ns-r-key)] lg:px-3 lg:py-2.5"
            >
              <FolderPlus className="size-4 shrink-0" aria-hidden />
              {tf.newFolder}
            </button>
          </li>
        )}
      </ul>
      {state.error && (
        <p role="alert" className="m-0 mt-2 text-[12px] text-[var(--color-fail)]">
          {t.media.readFailed}
        </p>
      )}
    </nav>
  );
}
