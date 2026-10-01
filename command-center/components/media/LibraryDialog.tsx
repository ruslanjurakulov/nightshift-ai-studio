"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useOverlay } from "@/components/a11y/useOverlay";

/**
 * The library's small dialogs (a folder's name, "delete this folder?", the
 * move picker): a bottom sheet on a phone, a centred card from `sm` up.
 *
 * useOverlay gives every one the same keyboard: focus moves in (to
 * `initialFocus`, else the card), Tab stays inside, Escape closes, and focus
 * goes back to the control that opened it.
 */
export function LibraryDialog({
  title,
  description,
  onClose,
  opener,
  initialFocus,
  closeLabel,
  children,
  footer,
  wide = false,
  busy = false,
  testId,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  opener?: RefObject<HTMLElement | null>;
  initialFocus?: RefObject<HTMLElement | null>;
  closeLabel: string;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** While a request runs, Escape and the scrim do not close it (the answer has somewhere to land). */
  busy?: boolean;
  testId?: string;
}) {
  const card = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const close = () => {
    if (!busy) onClose();
  };
  useOverlay(true, { onClose: close, container: card, opener, initialFocus });

  // The page behind a sheet must not scroll under a finger.
  useEffect(() => {
    const body = document.body;
    const before = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = before;
    };
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-end justify-center sm:items-center sm:p-4" data-testid={testId}>
      <div aria-hidden className="scrim-enter absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={close} />
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`sheet-enter relative flex max-h-[86dvh] w-full flex-col overflow-hidden rounded-t-[20px] border border-[var(--color-border)] bg-[var(--color-panel)] shadow-[var(--shadow-elevated)] outline-none sm:max-h-[80vh] sm:rounded-[20px] ${
          wide ? "sm:max-w-[520px]" : "sm:max-w-[420px]"
        }`}
      >
        <div className="flex items-start justify-between gap-4 px-5 pb-2 pt-5">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={titleId} className="m-0 break-words text-[16px] font-semibold leading-snug text-[var(--color-fg)]">
              {title}
            </h2>
            {description && (
              <p id={descId} className="m-0 text-[13px] leading-relaxed text-[var(--color-muted)]">
                {description}
              </p>
            )}
          </div>
          <button type="button" className="sheet-close shrink-0" aria-label={closeLabel} onClick={close} disabled={busy}>
            <X className="size-4" aria-hidden />
          </button>
        </div>
        {children && <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">{children}</div>}
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
