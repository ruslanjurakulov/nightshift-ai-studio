"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { nextFocusIndex } from "@/lib/feedback";

export interface ConfirmOptions {
  message: string;
  /** Defaults to a generic "Are you sure?". */
  title?: string;
  /** The button that goes ahead — name the action ("Disconnect"), not "OK". */
  confirmLabel: string;
  cancelLabel?: string;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal "are you sure" for destructive actions, in place of window.confirm —
 * which cannot be styled or translated beyond its message, reads as a browser
 * warning rather than the product, and is suppressed outright by some embedded
 * browsers (the action then silently never runs).
 *
 * Focus moves to Cancel on open, so a stray Enter backs out rather than
 * destroying something; Tab is kept inside; Escape and the scrim cancel; and
 * focus returns to whatever opened it.
 */
export function ConfirmDialog({
  open,
  options,
  onResolve,
}: {
  open: boolean;
  options: ConfirmOptions | null;
  onResolve: (ok: boolean) => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const bodyId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    // The page behind must not scroll under a modal on a phone.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      // The opener may have re-rendered away (a row removed); only return focus
      // to it while it is still on the page.
      const el = opener.current;
      if (el && el.isConnected) el.focus();
    };
  }, [open]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      // preventDefault also tells SectionShell's page-level Escape handler that
      // this press was spent closing the dialog, not leaving the section.
      e.preventDefault();
      e.stopPropagation();
      onResolve(false);
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = nextFocusIndex(current, items.length, e.shiftKey);
    if (next < 0) return;
    e.preventDefault();
    items[next].focus();
  }

  if (!open || !options || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-end justify-center p-4 sm:items-center" onKeyDown={onKeyDown}>
      <div
        aria-hidden
        className="scrim-enter absolute inset-0 bg-black/60 backdrop-blur-[2px]"
        onClick={() => onResolve(false)}
      />
      <div
        ref={panel}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="sheet-enter relative w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-5 shadow-[var(--shadow-elevated)]"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0" style={{ color: "var(--color-warn)" }} />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[15px] font-semibold text-[var(--color-fg)]">
              {options.title ?? t.ux.confirmTitle}
            </h2>
            <p id={bodyId} className="mt-1.5 break-words text-[13px] leading-relaxed text-[var(--color-muted)]">
              {options.message}
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => onResolve(false)}
            className="btn-sky is-quiet pill px-4 py-2 text-[13px]"
          >
            {options.cancelLabel ?? t.ux.confirmCancel}
          </button>
          <button
            type="button"
            onClick={() => onResolve(true)}
            className="btn-sky is-solid pill px-4 py-2 text-[13px]"
            style={{ borderColor: "var(--color-fail)", color: "var(--color-fail)" }}
          >
            {options.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * `await confirm({...})` — a drop-in for `window.confirm` that renders
 * ConfirmDialog. Render the returned `dialog` once, anywhere in the component.
 */
export function useConfirm(): { confirm: (opts: ConfirmOptions) => Promise<boolean>; dialog: React.ReactNode } {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    // A second ask while one is open settles the first as "no" — never leave a
    // caller awaiting forever.
    resolver.current?.(false);
    setOptions(opts);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const onResolve = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOptions(null);
  }, []);

  // Unmounting with a question open answers it "no".
  useEffect(() => () => resolver.current?.(false), []);

  return { confirm, dialog: <ConfirmDialog open={options !== null} options={options} onResolve={onResolve} /> };
}
