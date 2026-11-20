"use client";

import { forwardRef, useCallback, useEffect, useId, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The design system's keys (app/tokens.css, docs/design/TOKENS.md). No strings live here: every label,
 * including the one a screen reader hears while a key is busy, comes from the caller's dictionary, so en/ru/uz
 * stay in lib/i18n.
 */

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export function buttonClass({
  variant = "secondary",
  size = "md",
  icon = false,
  block = false,
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; icon?: boolean; block?: boolean; className?: string } = {}): string {
  const parts = ["ds-btn", `ds-btn--${variant}`];
  if (size !== "md") parts.push(`ds-btn--${size}`);
  if (icon) parts.push("ds-btn--icon");
  if (block) parts.push("ds-btn--block");
  if (className) parts.push(className);
  return parts.join(" ");
}

type BaseProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-busy"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
};

type BusyProps =
  | { loading?: false; busyLabel?: string }
  /** While loading, a reader hears `busyLabel` ("Saving…"); the visible label stays so the key keeps its width. */
  | { loading: true; busyLabel: string };

export type ButtonProps = BaseProps & BusyProps & { leading?: ReactNode; trailing?: ReactNode };

/**
 * A busy key is aria-disabled, not disabled: it keeps keyboard focus (a disabled button drops it to <body> mid
 * submit), and its click is swallowed so a double press cannot submit twice.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", block, loading = false, busyLabel, leading, trailing, className, children, onClick, type = "button", disabled, ...rest },
  ref,
) {
  const busy = loading === true;
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass({ variant, size, block, className })}
      disabled={disabled}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={(event) => {
        if (busy) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      {...rest}
    >
      {busy ? <span className="ds-spinner" aria-hidden="true" /> : leading}
      <span>{children}</span>
      {!busy && trailing}
      {busy && <span className="ds-sr-only" role="status">{busyLabel}</span>}
    </button>
  );
});

export type IconButtonProps = Omit<ButtonProps, "children" | "leading" | "trailing" | "aria-label"> & {
  /** The key's name for everyone: the accessible name, and the tooltip's words. Required — an icon is not a name. */
  label: string;
  icon: ReactNode;
  /** Show the label as a tooltip on hover and keyboard focus. Off for a key whose meaning is already on screen. */
  tooltip?: boolean;
  tooltipSide?: "top" | "bottom";
};

/**
 * An icon-only key, with an optional tooltip that opens on hover and on keyboard focus, closes on Escape, and is
 * aria-hidden (the label is already the accessible name; a reader should not hear it twice).
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, tooltip = true, tooltipSide = "top", variant = "quiet", size = "md", loading = false, busyLabel, className, onKeyDown, onFocus, onBlur, onMouseEnter, onMouseLeave, onClick, type = "button", disabled, ...rest },
  ref,
) {
  const tipId = useId();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const busy = loading === true;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={buttonClass({ variant, size, icon: true, className })}
      disabled={disabled}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={(event) => {
        if (busy) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        // Only a keyboard focus opens the tip: a tap or click focuses the key too, and a tip that then stays open
        // under the finger covers what the key just did.
        if (tooltip && event.currentTarget.matches(":focus-visible")) setOpen(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        close();
        onBlur?.(event);
      }}
      onMouseEnter={(event) => {
        if (tooltip) setOpen(true);
        onMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        close();
        onMouseLeave?.(event);
      }}
      {...rest}
    >
      {busy ? <span className="ds-spinner" aria-hidden="true" /> : icon}
      {busy && <span className="ds-sr-only" role="status">{busyLabel}</span>}
    </button>
  );

  if (!tooltip) return button;
  return (
    <span className="ds-tip-anchor">
      {button}
      <span id={tipId} className="ds-tip" data-side={tooltipSide} data-open={open ? "true" : "false"} aria-hidden="true">
        {label}
      </span>
    </span>
  );
});

/** A switch: role="switch" with its own visible label. The label is the caller's words. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  id?: string;
}) {
  const autoId = useId();
  const toggleId = id ?? autoId;
  const descId = `${toggleId}-desc`;
  return (
    <span className="inline-flex items-start gap-3">
      <button
        id={toggleId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? descId : undefined}
        className="ds-toggle mt-0.5"
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
      <span className="flex flex-col">
        <label htmlFor={toggleId} className="cursor-pointer text-sm font-medium text-[var(--ds-text)]">
          {label}
        </label>
        {description && (
          <span id={descId} className="text-xs text-[var(--ds-muted)]">
            {description}
          </span>
        )}
      </span>
    </span>
  );
}
