"use client";

import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { formatDayTime } from "@/lib/date-format";
import type { Resume } from "./useEditorDraft";

const btn = "btn-quiet inline-flex min-h-11 items-center justify-center px-4 text-sm";

/**
 * A draft found on this device when the project was opened. Not a dialog: the
 * editor stays usable underneath, nothing is applied until "Restore", and the
 * two buttons are ordinary focusable buttons at least 44 px high.
 */
export function DraftBanner({
  resume,
  onRestore,
  onDiscard,
}: {
  resume: Resume;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  const { t, locale } = useI18n();
  const te = t.editor;
  if (resume.kind === "none") return null;
  const when =
    resume.kind === "restore"
      ? formatDayTime(new Date(resume.draft.savedAt), locale)
      : "";
  const text =
    resume.kind === "restore"
      ? fmt(te.draftFound, { when })
      : resume.kind === "stale"
        ? te.draftStale
        : te.draftUnusable;
  return (
    <section
      aria-label={te.draftRegion}
      // The accent is inline: `.panel` sets its border unlayered, which beats a border-l-4 utility (the stripe never drew).
      style={{ borderLeftWidth: 4, borderLeftColor: "var(--color-warn)" }}
      className="panel flex min-w-0 flex-col gap-3 p-4 sm:flex-row sm:items-center"
    >
      <p
        role="status"
        className="m-0 min-w-0 flex-1 break-words text-sm text-[var(--color-fg)]"
      >
        {text}
      </p>
      <div className={`grid gap-2 sm:flex sm:flex-wrap ${resume.kind === "restore" ? "grid-cols-2" : "grid-cols-1"}`}>
        {resume.kind === "restore" ? (
          <button type="button" onClick={onRestore} className="btn-primary min-h-11 px-4 text-sm">
            {te.draftRestore}
          </button>
        ) : null}
        <button type="button" onClick={onDiscard} className={btn}>
          {te.draftDiscard}
        </button>
      </div>
    </section>
  );
}
