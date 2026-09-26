"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { CheckCircle2, Info, X, XCircle, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { makeToast, toastReducer, type Toast, type ToastInput, type ToastVariant } from "@/lib/toast";

type Notify = (message: string, opts?: { title?: string; duration?: number }) => void;

export interface ToastApi {
  show: (input: ToastInput) => void;
  success: Notify;
  error: Notify;
  info: Notify;
  dismiss: (id: string) => void;
}

// Outside the provider a toast is a no-op rather than a crash: every action
// that toasts also keeps its inline message, so nothing is lost if a surface
// renders somewhere the provider does not reach.
const NOOP: ToastApi = { show() {}, success() {}, error() {}, info() {}, dismiss() {} };

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}

const VARIANT: Record<ToastVariant, { color: string; Icon: LucideIcon }> = {
  success: { color: "var(--color-ok)", Icon: CheckCircle2 },
  error: { color: "var(--color-fail)", Icon: XCircle },
  info: { color: "var(--color-info)", Icon: Info },
};

let seq = 0;

/**
 * App-wide toasts: a short confirmation that an action landed (or did not)
 * that survives the operator scrolling away from the button they pressed.
 * Toasts add to an action's inline message; they never replace it, so the
 * state a form is in is still readable where the form is.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, dispatch] = useReducer(toastReducer, []);

  const dismiss = useCallback((id: string) => dispatch({ type: "dismiss", id }), []);
  const show = useCallback((input: ToastInput) => {
    seq += 1;
    dispatch({ type: "add", toast: makeToast(input, `t${Date.now().toString(36)}${seq}`) });
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      success: (message, opts) => show({ variant: "success", message, ...opts }),
      error: (message, opts) => show({ variant: "error", message, ...opts }),
      info: (message, opts) => show({ variant: "info", message, ...opts }),
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  const { t } = useI18n();
  return (
    // Always mounted, even when empty: a live region that appears together
    // with its first message is not announced by some screen readers.
    <section
      aria-label={t.ux.notifications}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[120] flex justify-center p-4 sm:inset-x-auto sm:right-0 sm:justify-end"
    >
      <ol aria-live="polite" aria-relevant="additions" className="m-0 flex w-full max-w-sm list-none flex-col gap-2 p-0">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} dismissLabel={t.ux.dismiss} />
        ))}
      </ol>
    </section>
  );
}

function ToastItem({
  toast,
  onDismiss,
  dismissLabel,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
  dismissLabel: string;
}) {
  const { color, Icon } = VARIANT[toast.variant];
  // Hovering or focusing a toast holds it: nobody should lose an error message
  // halfway through reading it, or while tabbing to its close button.
  const [held, setHeld] = useState(false);
  const remaining = useRef(toast.duration);

  useEffect(() => {
    if (held) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(1000, remaining.current - (Date.now() - started));
    };
  }, [held, onDismiss, toast.id]);

  return (
    <li
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className="reveal pointer-events-auto flex items-start gap-3 rounded-xl border bg-[var(--color-panel)] p-3 shadow-[var(--shadow-elevated)]"
      style={{ borderColor: `color-mix(in srgb, ${color} 45%, var(--color-border))` }}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" style={{ color }} strokeWidth={2} />
      <div className="min-w-0 flex-1 break-words text-[13px] leading-snug text-[var(--color-fg)]">
        {toast.title && <span className="font-semibold">{toast.title}: </span>}
        {toast.message}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label={dismissLabel}
        className="press -m-1 grid size-6 shrink-0 place-items-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-fg)]"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </li>
  );
}
