"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Keyboard, Magnet, Minus, Plus, Scan, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { nextFocusIndex } from "@/lib/feedback";
import { SHORTCUT_HELP } from "@/lib/editor-shortcuts";
import { ZOOM_FIT } from "@/lib/editor-timeline-view";
import type { TimelineView } from "./useTimelineView";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** An icon button that is at least 44 px square on a phone or a touch screen (.ns-chip). */
const iconBtn = "ns-chip min-w-11 justify-center px-0";
/** At its limit a zoom button stays focusable (focus must not vanish under a keyboard user) but reads as unavailable. */
const dim = "opacity-55";

/**
 * Zoom, fit, the snap switch and the shortcuts help, in one row above the
 * timeline. The buttons are the same keys the keyboard has (+, -, 0); each is
 * a real button, 44 px on a phone.
 */
export function TimelineViewBar({ view }: { view: TimelineView }) {
  const { t } = useI18n();
  const tv = t.editor.view;
  const snapDesc = useId();
  const atMin = view.zoom <= ZOOM_FIT + 0.001;
  const atMax = view.zoom >= view.maxZoom - 0.001;
  return (
    <div role="group" aria-label={tv.toolbar} className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={view.zoomOut}
        aria-disabled={atMin || undefined}
        aria-label={tv.zoomOut}
        className={`${iconBtn} ${atMin ? dim : ""}`}
      >
        <Minus className="size-3.5" aria-hidden />
      </button>
      {/* A div, not a span: the editor's save-status line is the page's one polite span. */}
      <div
        aria-live="polite"
        className="min-w-[4.5rem] text-center text-xs tabular-nums text-[var(--color-muted)]"
      >
        {fmt(tv.zoomLevel, { pct: Math.round(view.zoom * 100) })}
      </div>
      <button
        type="button"
        onClick={view.zoomIn}
        aria-disabled={atMax || undefined}
        aria-label={tv.zoomIn}
        className={`${iconBtn} ${atMax ? dim : ""}`}
      >
        <Plus className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        onClick={view.fit}
        aria-disabled={atMin || undefined}
        aria-label={tv.fitLabel}
        className={`ns-chip justify-center ${atMin ? dim : ""}`}
      >
        <Scan className="size-3.5" aria-hidden />
        {tv.fit}
      </button>
      <button
        type="button"
        onClick={() => view.setSnap(!view.snap)}
        aria-pressed={view.snap}
        aria-describedby={snapDesc}
        className="ns-chip justify-center"
      >
        <Magnet className="size-3.5" aria-hidden />
        {tv.snap}
      </button>
      <span id={snapDesc} className="sr-only">
        {tv.snapDesc}
      </span>
      <ShortcutsHelp />
    </div>
  );
}

/** The shortcuts button and its dialog: Escape and the scrim close it, Tab stays inside, focus goes back to the button. */
export function ShortcutsHelp() {
  const { t } = useI18n();
  const tv = t.editor.view;
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const noteId = useId();

  useEffect(() => {
    if (!open) return;
    closeBtn.current?.focus();
    const back = opener.current;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
      back?.focus();
    };
  }, [open]);

  const label: Record<string, string> = {
    play: tv.scPlay,
    split: tv.scSplit,
    remove: tv.scRemove,
    left: tv.scNudge,
    leftBig: tv.scNudgeBig,
    zoomIn: tv.scZoom,
    zoomFit: tv.scFit,
    undo: tv.scUndo,
    redo: tv.scRedo,
    save: tv.scSave,
  };
  const keyName: Record<string, string> = {
    Space: tv.keySpace,
    Delete: tv.keyDelete,
    Backspace: tv.keyBackspace,
    Shift: tv.keyShift,
    Ctrl: tv.keyCtrl,
  };

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      // Spent closing the dialog, not leaving the page (SectionShell listens for Escape too).
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const next = nextFocusIndex(items.indexOf(document.activeElement as HTMLElement), items.length, e.shiftKey);
    if (next < 0) return;
    e.preventDefault();
    items[next].focus();
  }

  return (
    <>
      <button
        ref={opener}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="ns-chip justify-center"
      >
        <Keyboard className="size-3.5" aria-hidden />
        {tv.shortcuts}
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div className="fixed inset-0 z-[130] flex items-end justify-center p-4 sm:items-center" onKeyDown={onKeyDown}>
              <div aria-hidden className="scrim-enter absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
              <div
                ref={panel}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={noteId}
                className="sheet-enter relative flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-5 shadow-[var(--shadow-elevated)]"
              >
                <div className="flex items-start gap-3">
                  <h2 id={titleId} className="m-0 min-w-0 flex-1 text-[15px] font-semibold text-[var(--color-fg)]">
                    {tv.shortcutsTitle}
                  </h2>
                  <button
                    ref={closeBtn}
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label={tv.close}
                    className="ns-chip min-w-11 shrink-0 justify-center px-0"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </div>
                <p id={noteId} className="mt-1 text-xs leading-relaxed text-[var(--color-muted)]">
                  {tv.shortcutsNote}
                </p>
                <dl className="m-0 mt-3 min-h-0 flex-1 overflow-y-auto">
                  {SHORTCUT_HELP.map((row) => (
                    <div
                      key={row.action}
                      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-[var(--color-border)] py-2"
                    >
                      <dt className="min-w-0 flex-1 basis-40 text-sm text-[var(--color-fg)]">{label[row.action]}</dt>
                      <dd className="m-0 flex flex-wrap items-center gap-1.5">
                        {row.keys.map((combo, i) => (
                          <span key={i} className="inline-flex items-center gap-1">
                            {combo.map((k) => (
                              <kbd
                                key={k}
                                className="rounded-[var(--ns-r-chip)] border border-[var(--color-border)] bg-[var(--color-panel-2)] px-1.5 py-0.5 text-xs font-medium text-[var(--color-fg)]"
                              >
                                {keyName[k] ?? k}
                              </kbd>
                            ))}
                          </span>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
