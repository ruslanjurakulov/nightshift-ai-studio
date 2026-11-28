"use client";

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { typedMatches } from "@/lib/confirm-tier";
import { useToast } from "@/components/feedback/ToastProvider";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/Sheet";

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
  /** Require an exact match for identifiers that the server compares verbatim. */
  exactConfirmation?: boolean;
  /**
   * A statement the person must tick before the key works ("I checked rights and AI-content labels"). Unticked on
   * every new question; the key stays disabled until it is ticked.
   */
  acknowledge?: string;
  /**
   * The work itself. With it the sheet stays open while it runs: both keys lock
   * (a second tap does nothing), the key shows a spinner, and a failure — `false`,
   * a returned message or a throw — is shown in the sheet with the keys live
   * again. Receives the input verbatim (empty when no text is requested).
   * Resolves the confirm as `true` only once the work succeeded.
   */
  run?: (typed: string) => Promise<boolean | string | void>;
  /** Shown as a toast once `run` has succeeded (so the result is seen after the sheet closes). */
  successMessage?: string;
}

/**
 * A modal "are you sure" for destructive actions, in place of window.confirm —
 * which cannot be styled or translated beyond its message, reads as a browser
 * warning rather than the product, and is suppressed outright by some embedded
 * browsers (the action then silently never runs).
 *
 * Focus moves to Cancel on open, so a stray Enter backs out rather than
 * destroying something; Tab is kept inside; Escape and the scrim cancel; and
 * focus returns to whatever opened it. The shell is the shared Sheet
 * (components/ui, Radix) with the alertdialog role: at the bottom of a phone,
 * in thumb reach, and centred from 640px. While the work runs, neither Escape
 * nor a press outside can close it.
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
  const ackHintId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
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

  // The question on screen now. A run that finishes after its question was replaced (a second ask settles the first as
  // "no") must not answer the new one: its yes was given to a different question.
  const asking = useRef<ConfirmOptions | null>(options);
  asking.current = options;

  // Each new question starts clean, with the safe key focused and the sheet at its top again.
  useEffect(() => {
    lock.current = false;
    setBusy(false);
    setFailure(null);
    setTyped("");
    setAcknowledged(false);
    if (open && options) {
      cancelRef.current?.focus({ preventScroll: true });
      if (panel.current) panel.current.scrollTop = 0;
    }
    // Only a new question resets; `open` follows it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  // A failed attempt disabled the keys for a moment: put focus back on the safe one.
  useEffect(() => {
    if (failure) cancelRef.current?.focus();
  }, [failure]);

  const matches = (word: string) => options?.exactConfirmation ? typed === word : typedMatches(typed, word);

  async function go() {
    if (lock.current || !options) return;
    if (options.typeToConfirm && !matches(options.typeToConfirm)) return;
    if (options.acknowledge && !acknowledged) return;
    if (!options.run) {
      onResolve(true);
      return;
    }
    const question = options;
    lock.current = true;
    setBusy(true);
    setFailure(null);
    let problem: string | null = null;
    try {
      const out = await options.run(typed);
      if (out === false) problem = t.ownerSafety.actionFailed;
      else if (typeof out === "string" && out) problem = out;
    } catch {
      problem = t.ownerSafety.actionFailed;
    }
    if (!alive.current || asking.current !== question) return;
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

  if (!options) return null;

  const danger = (options.tone ?? "danger") === "danger";
  const needsWord = Boolean(options.typeToConfirm);
  const wordOk = (!needsWord || matches(options.typeToConfirm ?? "")) && (!options.acknowledge || acknowledged);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && cancel()}>
      <SheetContent
        ref={panel}
        role="alertdialog"
        side="auto"
        closeLabel={null}
        className="block max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
        style={{ "--ui-sheet-w": "28rem" } as CSSProperties}
        onOpenAutoFocus={(e) => {
          // Focus the safe key WITHOUT scrolling to it: on a long sheet (a post's three texts) the key is at the bottom, and
          // focusing it the usual way opened the sheet scrolled down past the words and "this goes public". Start at the top.
          e.preventDefault();
          cancelRef.current?.focus({ preventScroll: true });
          if (panel.current) panel.current.scrollTop = 0;
        }}
        // While the work runs nothing closes it: the answer has somewhere to land, and the lock stays honest. Radix marks a
        // dismissing Escape as handled (preventDefault), so SectionShell's page-level Escape still knows it was spent here.
        onEscapeKeyDown={(e) => {
          if (lock.current) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (lock.current) e.preventDefault();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.stopPropagation();
        }}
      >
        <div className="flex items-start gap-3">
          <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0" style={{ color: danger ? "var(--color-fail)" : "var(--color-warn)" }} />
          <div className="min-w-0 flex-1">
            <SheetTitle className="break-words text-base font-semibold leading-snug text-[var(--color-fg)]">
              {options.title ?? t.ux.confirmTitle}
            </SheetTitle>
            <SheetDescription className="mt-1.5 break-words text-sm leading-relaxed text-[var(--color-muted)]">
              {options.message}
            </SheetDescription>
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
        {options.acknowledge && (
          <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm text-[var(--color-fg)]">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 size-5 shrink-0 accent-[var(--color-primary)]"
            />
            <span className="min-w-0 break-words">{options.acknowledge}</span>
          </label>
        )}
        {options.acknowledge && !acknowledged && (
          <p id={ackHintId} className="mt-1.5 pl-8 text-xs text-[var(--color-muted)]">
            {t.ux.confirmAckHint}
          </p>
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
            aria-describedby={options.acknowledge && !acknowledged ? ackHintId : undefined}
            className={`${danger ? "btn-danger" : "btn-primary"} min-h-12 px-4 text-sm disabled:opacity-55`}
          >
            {busy && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
            {busy ? t.ownerSafety.confirmWorking : options.confirmLabel}
          </button>
        </div>
      </SheetContent>
    </Sheet>
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
