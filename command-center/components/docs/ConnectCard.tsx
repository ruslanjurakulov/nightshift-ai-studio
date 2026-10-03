"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CodeBlock } from "@/components/docs/CodeBlock";
import type { CopyLabels } from "@/components/docs/CopyButton";

export type ConnectTab = {
  id: string;
  label: string;
  /** Where the snippet goes (a file, a menu, a terminal). */
  where: string;
  hint: string;
  code: string;
};

/**
 * The connect card: one tab per assistant, each with the place to put the
 * snippet, the snippet with a copy button, and one line worth knowing. The
 * tabs are a patch bay — engraved slots, the chosen one lit. Plain ARIA tabs:
 * arrow keys, Home and End move between them, only the chosen tab is a Tab
 * stop, and `#cursor` in the address opens that tab, so a link can point at the
 * assistant a colleague uses. Server-rendered with the first tab open, so the
 * page is complete before any script runs.
 */
export function ConnectCard({
  tabs,
  title,
  tablistLabel,
  whereLabel,
  placeholderNote,
  scrollLabel,
  copy,
}: {
  tabs: ConnectTab[];
  title: string;
  tablistLabel: string;
  whereLabel: string;
  placeholderNote: string;
  scrollLabel: string;
  copy: CopyLabels;
}) {
  const uid = useId();
  const [active, setActive] = useState(tabs[0].id);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    // Only a tab that exists: an unknown hash is just a hash.
    const fromHash = decodeURIComponent(window.location.hash.slice(1));
    if (tabs.some((t) => t.id === fromHash)) setActive(fromHash);
  }, [tabs]);

  function choose(id: string, focus = false) {
    setActive(id);
    try {
      window.history.replaceState(null, "", `#${id}`);
    } catch {
      /* a sandboxed frame may refuse; the tab still changes */
    }
    if (focus) refs.current[id]?.focus();
  }

  function onKey(e: React.KeyboardEvent, index: number) {
    const last = tabs.length - 1;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? index === last ? 0 : index + 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? index === 0 ? last : index - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : -1;
    if (next === -1) return;
    e.preventDefault();
    choose(tabs[next].id, true);
  }

  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <div className="st-connect">
      <div className="st-connect-head">
        <h2 className="st-connect-title">{title}</h2>
      </div>
      <div role="tablist" aria-label={tablistLabel} className="st-connect-tabs">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`${uid}-tab-${t.id}`}
            aria-selected={t.id === current.id}
            aria-controls={`${uid}-panel`}
            tabIndex={t.id === current.id ? 0 : -1}
            className="st-connect-tab"
            onClick={() => choose(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            <span className="st-connect-lamp" aria-hidden />
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${current.id}`} className="st-connect-panel">
        <p className="st-connect-where">
          <span className="st-connect-where-label">{whereLabel}</span>
          {current.where}
        </p>
        <CodeBlock code={current.code} name={current.label} scrollLabel={scrollLabel} copy={copy} />
        <p className="st-small">{current.hint}</p>
        <p className="st-small st-connect-note">{placeholderNote}</p>
      </div>
    </div>
  );
}
