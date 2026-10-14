"use client";

import { useId, useRef, useState, type ReactNode } from "react";

/**
 * Small building blocks shared by the effect, crop, animation, motion, speed
 * and clean-up panels of the editor, so each panel is only its own wording and
 * the model edit it makes:
 *
 *   * `Disclosure`: a native <details> section (a 44px summary, opens by itself
 *     when the feature is already in use) so a long inspector stays short;
 *   * `SliderRow`: a native range input with a visible value, 44px tall, whose
 *     drag (or one key press) is ONE undo step through the `group` the editor's
 *     history coalesces (the same contract as ClipGradePanel);
 *   * `RadioChips`: a native radio group drawn as the editor's chips, a key at
 *     least 44px tall, with a reason under any key that cannot be used;
 *   * `ToggleRow`: a checkbox row with its explanation tied to it.
 */

/** A collapsible section; `active` opens it on first render (a clip that
 *  already uses the feature shows it). */
export function Disclosure({
  title,
  active = false,
  testId,
  children,
}: {
  title: string;
  active?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  const [initial] = useState(active);
  return (
    <details
      className="group m-0 flex min-w-0 flex-col gap-1.5 rounded-[var(--ns-r-key)] border border-[var(--color-border)] px-3"
      open={initial || undefined}
      data-testid={testId}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-xs font-semibold text-[var(--color-fg)] [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        {active ? (
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full bg-[var(--ns-amber)]"
          />
        ) : null}
      </summary>
      <div className="flex min-w-0 flex-col gap-2 pb-3">{children}</div>
    </details>
  );
}

/** One undo step per gesture: a new id on pointer-down or a fresh key press. */
export function useGesture(): { next: () => void; group: () => string } {
  const id = useId();
  const n = useRef(0);
  return {
    next: () => {
      n.current += 1;
    },
    group: () => `${id}-${n.current}`,
  };
}

export function SliderRow({
  label,
  value,
  min,
  max,
  step,
  text,
  onChange,
  disabled = false,
  describedBy,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** The value as a person reads it ("40%", "12°"). */
  text: string;
  /** `group` is the same for every change of one gesture. */
  onChange: (value: number, group: string) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  const g = useGesture();
  return (
    <label className="flex min-w-0 flex-col text-xs text-[var(--color-muted)]">
      <span className="flex items-baseline justify-between gap-2">
        <span>{label}</span>
        <span className="tabular-nums text-[var(--color-fg)]" aria-hidden>
          {text}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        disabled={disabled}
        aria-valuetext={text}
        aria-describedby={describedBy}
        onPointerDown={g.next}
        onKeyDown={(e) => {
          if (!e.repeat) g.next();
        }}
        onChange={(e) => onChange(Number(e.target.value), g.group())}
        className="h-11 w-full min-w-0 accent-[var(--color-primary)]"
      />
    </label>
  );
}

export interface ChipOption<T extends string | number> {
  value: T;
  label: string;
  /** A key that cannot be used now; the group's hint says why. */
  disabled?: boolean;
}

export function RadioChips<T extends string | number>({
  legend,
  options,
  value,
  onChange,
  hint,
  testId,
  columns,
}: {
  legend: string;
  options: readonly ChipOption<T>[];
  /** null = none of the keys is lit. */
  value: T | null;
  onChange: (v: T) => void;
  hint?: ReactNode;
  testId?: string;
  /** A grid of min-width columns instead of a wrapping row (long labels). */
  columns?: string;
}) {
  const id = useId();
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
      aria-describedby={hint ? `${id}-hint` : undefined}
      data-testid={testId}
    >
      <legend className="mb-1 p-0 text-xs text-[var(--color-muted)]">
        {legend}
      </legend>
      <div
        className={columns ? "grid gap-1.5" : "flex flex-wrap gap-1.5"}
        style={
          columns
            ? { gridTemplateColumns: `repeat(auto-fill, minmax(${columns}, 1fr))` }
            : undefined
        }
      >
        {options.map((o) => {
          const on = value === o.value;
          return (
            <label
              key={String(o.value)}
              className="ns-chip min-w-0"
              style={{ minHeight: "2.75rem" }}
              data-radio=""
              data-on={on ? "true" : undefined}
              data-disabled={o.disabled ? "true" : undefined}
            >
              <input
                type="radio"
                name={`${id}-r`}
                value={String(o.value)}
                checked={on}
                disabled={o.disabled}
                onChange={() => onChange(o.value)}
                className="sr-only"
              />
              <span className="min-w-0 break-words leading-tight">{o.label}</span>
            </label>
          );
        })}
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="m-0 text-xs text-[var(--color-muted)]">
          {hint}
        </p>
      ) : null}
    </fieldset>
  );
}

export function ToggleRow({
  label,
  checked,
  onChange,
  hint,
  disabled = false,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  hint?: ReactNode;
  disabled?: boolean;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid={testId}>
      <label className="tap-row flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) => onChange(e.target.checked)}
          className="size-4 accent-[var(--color-primary)]"
        />
        {label}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="m-0 text-xs text-[var(--color-muted)]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
