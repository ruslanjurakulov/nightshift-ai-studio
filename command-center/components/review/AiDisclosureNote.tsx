"use client";

import { useI18n } from "@/lib/i18n/context";
import type { AiDisclosureView } from "@/lib/aiDisclosure";

/**
 * The AI-content label this video went out with, on the review section of the video page (lib/aiDisclosure.ts reads it
 * from the event the upload recorded; modules/ai_disclosure.py decides it).
 *
 * `view` null means no readable record: unknown (an old video, or the event has not synced yet) — said as unknown,
 * never as "not labelled". `uploaded` false is a held run: nothing is decided until it is uploaded. Display only: nothing
 * here sends, changes or re-decides a label.
 */
export function AiDisclosureNote({ view, uploaded }: { view: AiDisclosureView | null; uploaded: boolean }) {
  const { t } = useI18n();
  const ai = t.review.ai;
  return (
    <section className="section-card flex flex-col gap-2" data-testid="ai-disclosure" aria-labelledby="ai-disclosure-title">
      <h2 id="ai-disclosure-title" className="t-label">
        {ai.title}
      </h2>
      {view ? (
        <>
          <p className="m-0 text-sm font-medium">
            {view.label ? ai.on : view.reasons.length === 1 && view.reasons[0] === "mode_never" ? ai.offNever : ai.off}
          </p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {view.reasons.map((r) => (
              <li key={r} className="text-sm text-[var(--color-muted)]">
                — {ai.reasons[r]}
              </li>
            ))}
          </ul>
          <p className="m-0 text-sm text-[var(--color-muted)]">
            {ai.mode[view.mode]}
            {view.label ? ` · ${view.line ? ai.lineOn : ai.lineOff}` : ""}
          </p>
          {view.overrides.map((o) => (
            <p key={o} className="m-0 text-xs text-[var(--color-warn)]">
              {ai.overrides[o]}
            </p>
          ))}
          <p className="m-0 text-xs text-[var(--color-muted)]">{ai.note}</p>
        </>
      ) : (
        <p className="m-0 text-sm text-[var(--color-muted)]">{uploaded ? ai.unknown : ai.notYet}</p>
      )}
    </section>
  );
}
