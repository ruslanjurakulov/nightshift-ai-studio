"use client";

/**
 * The live canvas before anything is planned (LIVE_CREATION_PLAN §2 "empty"): one line that says what to do, and three
 * example sentences. Picking one only fills the chat's composer (the caller's `onPick`); it sends nothing and spends nothing.
 */
import { useId } from "react";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";
import "./live.css";

export function LiveEmpty({ onPick, className }: { onPick?: (sentence: string) => void; className?: string }) {
  const { t } = useI18n();
  const e = t.liveNodes.empty;
  const id = useId();
  return (
    <section className={cn("live-empty", className)} aria-labelledby={`${id}-t`}>
      <h2 id={`${id}-t`} className="ds-t-heading-md">
        {e.title}
      </h2>
      <p className="ds-t-body-sm live-empty-line">{e.prompt}</p>
      {onPick ? (
        <div className="live-empty-examples">
          <p className="ds-t-label live-empty-label" id={`${id}-x`}>
            {e.examplesLabel}
          </p>
          <ul aria-labelledby={`${id}-x`}>
            {e.examples.map((x) => (
              <li key={x}>
                <button type="button" className="live-empty-chip" onClick={() => onPick(x)}>
                  {x}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
