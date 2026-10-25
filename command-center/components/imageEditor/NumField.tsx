"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A whole-number field that commits while the person types (a number that is valid right now) but lets the box be empty
 * or half-typed meanwhile. It shows the parent's value again when focus leaves, so a value the editor clamped
 * (a crop cannot leave the picture) is what the box ends up saying.
 */
export function NumField({
  id,
  label,
  value,
  min,
  max,
  onCommit,
  onEnd,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (n: number) => void;
  onEnd?: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const focused = useRef(false);
  // The value this box itself last asked for (after its own clamp). A change of `value` to anything ELSE came from outside (an undo, a
  // keyboard nudge on the canvas): the half-typed text no longer describes the number, so it is dropped and the box shows the number.
  const asked = useRef<number | null>(null);
  useEffect(() => {
    if (value === asked.current) {
      asked.current = null;
      return;
    }
    setText(null);
  }, [value]);
  const shown = text !== null && focused.current ? text : String(value);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="studio-label">{label}</label>
      <div className="studio-field">
        <input
          id={id}
          type="text"
          inputMode="numeric"
          pattern="[0-9\-]*"
          value={shown}
          onFocus={() => {
            focused.current = true;
            setText(String(value));
          }}
          onChange={(e) => {
            const raw = e.target.value;
            setText(raw);
            if (/^-?\d{1,6}$/.test(raw)) {
              const n = Number(raw);
              const clamped = Math.max(min, Math.min(max, n));
              asked.current = clamped;
              onCommit(clamped);
            }
          }}
          onBlur={() => {
            focused.current = false;
            asked.current = null;
            setText(null);
            onEnd?.();
          }}
          className="min-h-11 w-full min-w-0 bg-transparent px-3 text-base text-[var(--color-fg)] outline-none sm:text-[14px]"
        />
      </div>
    </div>
  );
}
