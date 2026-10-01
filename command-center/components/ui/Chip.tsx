"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * A small key with a pilot lamp (IDENTITY.md): a setting under the prompt
 * (shape, quality, count), a style, a filter. A toggle chip (`pressed` given)
 * is a button with aria-pressed and a lamp that fills when on, so "on" never
 * rests on colour alone. Without `pressed` it is a plain action chip.
 *
 * Shares its look with the Studio's .studio-chip, so a screen can adopt the
 * component or keep the class and still match.
 */
export function Chip({
  pressed,
  count,
  icon,
  plain = false,
  children,
  className,
  type = "button",
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed"> & {
  pressed?: boolean;
  /** A readout, not a key: drawn as a chip but not a button (a count of what is attached). */
  plain?: boolean;
  /** A real count beside the name (references attached, results in a filter). */
  count?: number | null;
  icon?: ReactNode;
  children: ReactNode;
}) {
  if (plain) {
    return (
      <span className={`ns-chip${className ? ` ${className}` : ""}`} data-plain="true">
        {icon}
        <span className="truncate">{children}</span>
        {typeof count === "number" && Number.isFinite(count) && <span className="ns-chip-count ns-tc">{count}</span>}
      </span>
    );
  }
  return (
    <button
      type={type}
      {...rest}
      aria-pressed={pressed === undefined ? undefined : pressed}
      className={`ns-chip${className ? ` ${className}` : ""}`}
    >
      {icon}
      <span className="truncate">{children}</span>
      {typeof count === "number" && Number.isFinite(count) && <span className="ns-chip-count ns-tc">{count}</span>}
    </button>
  );
}

/**
 * The row of chips under a prompt. One line that scrolls sideways on a phone
 * (a wall of wrapped keys pushes the prompt off screen); `wrap` lets it wrap
 * from `sm` up. A named group, so a screen reader hears what the chips set.
 */
export function ChipRow({
  label,
  wrap = false,
  children,
  className,
}: {
  label: string;
  wrap?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={`ns-chip-row${className ? ` ${className}` : ""}`} data-wrap={wrap ? "true" : undefined}>
      {children}
    </div>
  );
}
