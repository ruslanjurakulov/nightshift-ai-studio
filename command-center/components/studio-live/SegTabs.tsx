"use client";

import { useRef, type KeyboardEvent } from "react";

/**
 * A small tablist (WAI-ARIA tabs, automatic activation): one tab in the tab order, arrows and Home/End move between them. Each tab
 * controls the tabpanel `${idBase}-panel-${id}`; the caller renders the panels with those ids (tabPanelProps).
 */
export function SegTabs<K extends string>({
  items,
  value,
  onChange,
  label,
  idBase,
  className = "",
  testIdBase,
}: {
  items: readonly { id: K; label: string }[];
  value: K;
  onChange: (id: K) => void;
  label: string;
  idBase: string;
  className?: string;
  testIdBase?: string;
}) {
  const refs = useRef(new Map<K, HTMLButtonElement | null>());
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = items.findIndex((x) => x.id === value);
    const to =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? (i + 1) % items.length
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? (i - 1 + items.length) % items.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? items.length - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    onChange(items[to].id);
    refs.current.get(items[to].id)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={className} onKeyDown={move}>
      {items.map((x) => (
        <button
          key={x.id}
          ref={(el) => {
            refs.current.set(x.id, el);
          }}
          type="button"
          role="tab"
          id={`${idBase}-tab-${x.id}`}
          aria-selected={value === x.id}
          aria-controls={`${idBase}-panel-${x.id}`}
          tabIndex={value === x.id ? 0 : -1}
          onClick={() => onChange(x.id)}
          data-testid={testIdBase ? `${testIdBase}-${x.id}` : undefined}
        >
          {x.label}
        </button>
      ))}
    </div>
  );
}

export const tabPanelProps = (idBase: string, id: string) => ({
  role: "tabpanel" as const,
  id: `${idBase}-panel-${id}`,
  "aria-labelledby": `${idBase}-tab-${id}`,
});
