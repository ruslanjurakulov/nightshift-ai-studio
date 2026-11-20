"use client";

import type { Cue } from "@/lib/captions";
import { reviewCaptions } from "@/lib/captionReview";
import { useI18n } from "@/lib/i18n/context";

/** Read-only advice outside the preview picture; never repairs or gates export. */
export function CaptionReviewHints({ cues, pictureEnd }: { cues: readonly Cue[]; pictureEnd: number }) {
  const { t, fmt } = useI18n();
  const copy = t.editor.captionReview;
  const flags = reviewCaptions(cues, pictureEnd);
  if (!flags.length) return null;
  return (
    <aside aria-label={copy.title} className="text-xs text-[var(--color-muted)]">
      <p className="m-0 font-medium">{copy.title}</p>
      <p className="m-0">{copy.note}</p>
      <ul className="m-0 pl-4">
        {flags.slice(0, 5).map((flag) => (
          <li key={flag.index}>
            {fmt(copy.cue, { n: flag.index + 1 })}: {flag.reasons.map((reason) => copy[reason]).join(" ")}
          </li>
        ))}
      </ul>
      {flags.length > 5 ? <p className="m-0">{fmt(copy.more, { n: flags.length - 5 })}</p> : null}
    </aside>
  );
}
