"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";

/**
 * The mode switcher (the reference products' header dropdown, drawn as a row
 * of interlocked keys): one of a few modes, the pressed key lit. One tab stop,
 * ←/→ (↑/↓) move and choose, Home/End jump.
 *
 * Two readings of the same keys: a `radio` group (the default — a choice among
 * settings) or, with `semantics="tab"`, a tablist whose tabs carry the ids
 * `${idPrefix}-${value}` so the panel they switch can name them. `value` may be
 * null when the current mode belongs to another group of keys (the tool row
 * under the switch): then no key is lit and the first is the tab stop.
 */
export function SegmentedSwitch<T extends string>({
  label,
  options,
  value,
  onChange,
  size = "md",
  semantics = "radio",
  idPrefix,
  controls,
  className,
}: {
  label: string;
  options: readonly { value: T; label: string; icon?: ReactNode; disabled?: boolean }[];
  value: T | null;
  onChange: (value: T) => void;
  size?: "md" | "lg";
  semantics?: "radio" | "tab";
  /** tab only: ids of the tabs are `${idPrefix}-${value}`. */
  idPrefix?: string;
  /** tab only: the id of the panel the tabs switch. */
  controls?: string;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const found = options.findIndex((o) => o.value === value);
  const current = found >= 0 ? found : -1;
  const stop = current >= 0 ? current : (enabled[0] ?? 0);
  const tabs = semantics === "tab";

  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const at = enabled.indexOf(i);
    let to = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") to = enabled[(at + 1) % enabled.length];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (e.key === "Home") to = enabled[0];
    else if (e.key === "End") to = enabled[enabled.length - 1];
    if (to === undefined || to < 0) return;
    e.preventDefault();
    onChange(options[to].value);
    refs.current[to]?.focus();
  }

  return (
    <div
      role={tabs ? "tablist" : "radiogroup"}
      aria-label={label}
      className={`ns-seg${className ? ` ${className}` : ""}`}
      data-size={size}
    >
      {options.map((o, i) => {
        const on = i === current;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role={tabs ? "tab" : "radio"}
            {...(tabs
              ? { "aria-selected": on, id: idPrefix ? `${idPrefix}-${o.value}` : undefined, "aria-controls": controls }
              : { "aria-checked": on })}
            tabIndex={i === stop ? 0 : -1}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
