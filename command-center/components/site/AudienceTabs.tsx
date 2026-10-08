"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/**
 * "Who is it for": one tab per way into the product, a panel under the tabs (the words and the product's own picture for
 * that job). The pattern is a tablist in the full sense: arrows, Home and End move between the tabs, only the open tab is a tab
 * stop, and every panel is in the page (the closed ones `hidden`), so the page reads whole without script and a search engine
 * sees all three. The panels are built on the server and handed in as nodes; this file holds only the selection.
 */
export function AudienceTabs({ label, tabs }: { label: string; tabs: { id: string; label: string; panel: ReactNode }[] }) {
  const uid = useId();
  const [open, setOpen] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const go = (i: number) => {
    const n = (i + tabs.length) % tabs.length;
    setOpen(n);
    refs.current[n]?.focus();
  };
  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(tabs.length - 1);
    else return;
    e.preventDefault();
  };
  return (
    <div className="nx-aud">
      <div className="nx-aud-tabs" role="tablist" aria-label={label}>
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${uid}-tab-${t.id}`}
            aria-selected={i === open}
            aria-controls={`${uid}-panel-${t.id}`}
            tabIndex={i === open ? 0 : -1}
            className="nx-aud-tab"
            onClick={() => setOpen(i)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t, i) => (
        <div key={t.id} role="tabpanel" id={`${uid}-panel-${t.id}`} aria-labelledby={`${uid}-tab-${t.id}`} hidden={i !== open} className="nx-aud-panel">
          {t.panel}
        </div>
      ))}
    </div>
  );
}
