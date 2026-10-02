"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";

/**
 * The mode switcher (the reference products' header dropdown, drawn as a row
 * of interlocked keys): one of a few modes, the pressed key lit. A radio
 * group — one tab stop, ←/→ (↑/↓) move and choose, Home/End jump — so it reads
 * and drives like the choice it is.
 */
export function SegmentedSwitch<T extends string>({
  label,
  options,
  value,
  onChange,
  size = "md",
  className,
}: {
  label: string;
  options: readonly { value: T; label: string; icon?: ReactNode; disabled?: boolean }[];
  value: T;
  onChange: (value: T) => void;
  size?: "md" | "lg";
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const current = Math.max(0, options.findIndex((o) => o.value === value));

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
    <div role="radiogroup" aria-label={label} className={`ns-seg${className ? ` ${className}` : ""}`} data-size={size}>
      {options.map((o, i) => {
        const on = i === current;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
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
