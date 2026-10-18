"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { nextFocusIndex } from "@/lib/feedback";
import { typedMatches } from "@/lib/confirm-tier";
import { useToast } from "@/components/feedback/ToastProvider";

export interface ConfirmDetail {
  label: string;
  value: string;
  /**
   * Words to be read, not a figure: shown on their own line, left-aligned, with their line breaks kept (a post's text
   * in a language the owner reads). The default is a short value set right beside its label.
   */
  multiline?: boolean;
}

export interface ConfirmOptions {
  message: string;
  /** Defaults to a generic "Are you sure?". Name the object: "Remove ana@x.uz?". */
  title?: string;
  /** The button that goes ahead — name the action ("Disconnect"), not "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** "danger" (the default, a solid red key) or "primary" for a consequential but not destructive action. */
  tone?: "danger" | "primary";
  /** Facts to read before agreeing — who, how much — shown under the message. */
  details?: ConfirmDetail[];
  /** Tier 3: this text must be typed (case, spaces and ʻ ignored) before the key works. */
  typeToConfirm?: string;
  /**
   * The work itself. With it the sheet stays open while it runs: both keys lock
   * (a second tap does nothing), the key shows a spinner, and a failure — `false`,
   * a returned message or a throw — is shown in the sheet with the keys live
   * again. Resolves the confirm as `true` only once the work succeeded.
   */
  run?: () => Promise<boolean | string | void>;
  /** Shown as a toast once `run` has succeeded (so the result is seen after the sheet closes). */
  successMessage?: string;
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
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  // Set synchronously on the first tap: state alone lags a render, so a fast
  // second tap would still see "not busy" and run the action twice.
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Each new question starts clean.
  useEffect(() => {
    lock.current = false;
    setBusy(false);
    setFailure(null);
    setTyped("");
  }, [options]);

  // A failed attempt disabled the keys for a moment: put focus back on the safe one.
  useEffect(() => {
    if (failure) cancelRef.current?.focus();
  }, [failure]);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Focus the safe key WITHOUT scrolling to it: on a long sheet (a post's three texts) the key is at the bottom, and
    // focusing it the usual way opened the sheet scrolled down past the words and "this goes public". Start at the top.
    cancelRef.current?.focus({ preventScroll: true });
    if (panel.current) panel.current.scrollTop = 0;
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

  async function go() {
    if (lock.current || !options) return;
    if (options.typeToConfirm && !typedMatches(typed, options.typeToConfirm)) return;
    if (!options.run) {
      onResolve(true);
      return;
    }
    lock.current = true;
    setBusy(true);
    setFailure(null);
    let problem: string | null = null;
    try {
      const out = await options.run();
      if (out === false) problem = t.ownerSafety.actionFailed;
      else if (typeof out === "string" && out) problem = out;
    } catch {
      problem = t.ownerSafety.actionFailed;
    }
    if (!alive.current) return;
    if (problem === null) {
      onResolve(true);
      return;
    }
    // Failed: nothing changed, so the keys come back and the person can retry or cancel.
    lock.current = false;
    setBusy(false);
    setFailure(problem);
  }

  function cancel() {
    if (lock.current) return;
    onResolve(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      // preventDefault also tells SectionShell's page-level Escape handler that
      // this press was spent closing the dialog, not leaving the section.
      e.preventDefault();
      e.stopPropagation();
      cancel();
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

  const danger = (options.tone ?? "danger") === "danger";
  const needsWord = Boolean(options.typeToConfirm);
  const wordOk = !needsWord || typedMatches(typed, options.typeToConfirm ?? "");

  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-end justify-center p-4 sm:items-center" onKeyDown={onKeyDown}>
      <div
        aria-hidden
        className="scrim-enter absolute inset-0 bg-black/60 backdrop-blur-[2px]"
        onClick={cancel}
      />
      <div
        ref={panel}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="sheet-enter relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-5 shadow-[var(--shadow-elevated)]"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0" style={{ color: danger ? "var(--color-fail)" : "var(--color-warn)" }} />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="break-words text-base font-semibold leading-snug text-[var(--color-fg)]">
              {options.title ?? t.ux.confirmTitle}
            </h2>
            <p id={bodyId} className="mt-1.5 break-words text-sm leading-relaxed text-[var(--color-muted)]">
              {options.message}
            </p>
          </div>
        </div>
        {options.details && options.details.length > 0 && (
          <dl className="mt-4 divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] text-sm">
            {options.details.map((d) => (
              <div key={d.label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2">
                <dt className="text-[var(--color-muted)]">{d.label}</dt>
                <dd
                  className={
                    d.multiline
                      ? "min-w-0 basis-full whitespace-pre-wrap break-words text-left font-normal text-[var(--color-fg)]"
                      : "tnum min-w-0 break-words text-right font-semibold text-[var(--color-fg)]"
                  }
                >
                  {d.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {needsWord && (
          <label className="mt-4 flex flex-col gap-1.5 text-sm text-[var(--color-muted)]">
            <span>
              {fmt(t.ownerSafety.typeToConfirm, { word: options.typeToConfirm ?? "" })}
            </span>
            <input
              type="text"
              value={typed}
              disabled={busy}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void go();
                }
              }}
              className="ns-field"
            />
          </label>
        )}
        {/* Always mounted, so a screen reader hears a failure that appears later. */}
        <p role="alert" className={failure ? "mt-3 break-words text-sm font-medium text-[var(--color-fail)]" : "sr-only"}>
          {failure}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:ml-auto sm:flex sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            onClick={cancel}
            disabled={busy}
            className="btn-quiet min-h-12 px-4 text-sm disabled:opacity-55"
          >
            {options.cancelLabel ?? t.ux.confirmCancel}
          </button>
          <button
            type="button"
            onClick={() => void go()}
            disabled={busy || !wordOk}
            aria-busy={busy}
            className={`${danger ? "btn-danger" : "btn-primary"} min-h-12 px-4 text-sm disabled:opacity-55`}
          >
            {busy && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
            {busy ? t.ownerSafety.confirmWorking : options.confirmLabel}
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

  const toast = useToast();
  const current = useRef<ConfirmOptions | null>(null);
  current.current = options;

  const onResolve = useCallback(
    (ok: boolean) => {
      const done = current.current;
      resolver.current?.(ok);
      resolver.current = null;
      setOptions(null);
      if (ok && done?.run && done.successMessage) toast.success(done.successMessage);
    },
    [toast],
  );

  // Unmounting with a question open answers it "no".
  useEffect(() => () => resolver.current?.(false), []);

  return { confirm, dialog: <ConfirmDialog open={options !== null} options={options} onResolve={onResolve} /> };
}
