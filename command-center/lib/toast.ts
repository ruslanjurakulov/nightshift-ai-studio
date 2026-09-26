/**
 * The toast queue, as a pure reducer — the provider (components/feedback/
 * ToastProvider.tsx) only adds timers and markup on top of it, so the rules
 * that decide what the operator sees are testable without a DOM.
 */

export type ToastVariant = "success" | "error" | "info";

export interface Toast {
  id: string;
  variant: ToastVariant;
  message: string;
  /** Optional lead-in, e.g. the provider a key was saved for. */
  title?: string;
  /** Milliseconds before it dismisses itself. */
  duration: number;
}

export type ToastInput = {
  variant: ToastVariant;
  message: string;
  title?: string;
  duration?: number;
};

export type ToastAction =
  | { type: "add"; toast: Toast }
  | { type: "dismiss"; id: string }
  | { type: "clear" };

/**
 * More than this and the stack covers the screen it is reporting on. The
 * oldest goes first: it has been visible longest, and the newest is the one
 * that answers what the operator just clicked.
 */
export const MAX_TOASTS = 4;

/**
 * An error stays up twice as long as a success. A success confirms what the
 * operator already expected; an error is the one they need time to read — and
 * it usually names the fix.
 */
export const TOAST_DURATION: Record<ToastVariant, number> = {
  success: 4000,
  info: 5000,
  error: 8000,
};

export function makeToast(input: ToastInput, id: string): Toast {
  const duration =
    input.duration !== undefined && Number.isFinite(input.duration) && input.duration > 0
      ? input.duration
      : TOAST_DURATION[input.variant];
  return {
    id,
    variant: input.variant,
    message: input.message,
    ...(input.title ? { title: input.title } : {}),
    duration,
  };
}

export function toastReducer(state: Toast[], action: ToastAction): Toast[] {
  switch (action.type) {
    case "add": {
      // The same message twice in a row (a double click, a retry that failed
      // the same way) refreshes the one on screen instead of stacking a copy.
      const withoutDup = state.filter(
        (t) =>
          !(
            t.variant === action.toast.variant &&
            t.message === action.toast.message &&
            t.title === action.toast.title
          ),
      );
      const next = [...withoutDup, action.toast];
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
    }
    case "dismiss":
      return state.some((t) => t.id === action.id) ? state.filter((t) => t.id !== action.id) : state;
    case "clear":
      return state.length ? [] : state;
  }
}
