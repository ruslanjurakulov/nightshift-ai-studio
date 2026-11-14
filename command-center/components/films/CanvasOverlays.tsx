"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { FilmStudioDictionary } from "@/lib/i18n/film-studio";

export interface CanvasCommand {
  id: string;
  label: string;
  keys?: string;
  /** Why it cannot run now; a command that cannot run is listed with its reason, never hidden. */
  disabledReason?: string;
  run: () => void;
}

/** Keep Tab inside a dialog, and give focus back to whoever opened it when it closes. */
function useDialogFocus(open: boolean, box: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open]);
  return (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>("button:not([disabled]), input, [tabindex='0']")];
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
}

/**
 * The canvas's command palette (Ctrl/Cmd+K): every action on the project in one or two keystrokes. It lists only real actions; one
 * that cannot run now (nothing selected, read-only, the limit reached) is shown disabled with its reason. Nothing in it prices or
 * starts anything.
 */
export function CommandPalette({ t, commands, onClose }: { t: FilmStudioDictionary; commands: readonly CanvasCommand[]; onClose: () => void }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const trap = useDialogFocus(true, box);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? commands.filter((c) => c.label.toLowerCase().includes(needle)) : [...commands];
  }, [q, commands]);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setActive(0), [q]);

  const run = (c: CanvasCommand | undefined) => {
    if (!c || c.disabledReason) return;
    onClose();
    // After the dialog has closed and focus is back on the canvas, so the action's own focus moves win.
    requestAnimationFrame(() => c.run());
  };

  return (
    <>
      <div className="fs-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={box}
        className="fs-dialog fs-glass"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-h`}
        onKeyDown={(e) => {
          trap(e);
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(shown.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            run(shown[active]);
          }
        }}
        data-testid="fs-palette"
      >
        <div className="fs-row">
          <h2 id={`${id}-h`} className="fs-h2 fs-grow">
            {t.palette.title}
          </h2>
          <button type="button" className="fs-icon-key" onClick={onClose} aria-label={t.scene.close}>
            <X aria-hidden className="size-4" />
          </button>
        </div>
        <input
          ref={input}
          className="ns-field"
          value={q}
          placeholder={t.palette.placeholder}
          aria-label={t.palette.placeholder}
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={shown[active] ? `${id}-${shown[active].id}` : undefined}
          onChange={(e) => setQ(e.target.value)}
        />
        {shown.length === 0 ? (
          <p className="fs-small">{t.palette.empty}</p>
        ) : (
          <ul id={`${id}-list`} role="listbox" className="fs-cmds" aria-label={t.palette.title}>
            {shown.map((c, i) => (
              <li
                key={c.id}
                id={`${id}-${c.id}`}
                role="option"
                aria-selected={i === active}
                aria-disabled={c.disabledReason ? true : undefined}
                className="fs-cmd"
                onMouseEnter={() => setActive(i)}
                onClick={() => run(c)}
              >
                <span className="flex min-w-0 flex-col">
                  <span>{c.label}</span>
                  {c.disabledReason && <span className="fs-small">{c.disabledReason}</span>}
                </span>
                {c.keys && <kbd className="fs-kbd">{c.keys}</kbd>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** The keyboard shortcuts, in one overlay ("?"). */
export function ShortcutsHelp({ t, mod, onClose }: { t: FilmStudioDictionary; mod: string; onClose: () => void }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const trap = useDialogFocus(true, box);
  useEffect(() => close.current?.focus(), []);
  const rows: [string, string][] = [
    ["← → ↑ ↓", t.shortcuts.move],
    ["Home / End", t.shortcuts.jump],
    ["Enter", t.shortcuts.open],
    ["F2", t.shortcuts.edit],
    ["Alt + ↑ ↓", t.shortcuts.reorder],
    ["N", t.shortcuts.add],
    ["D", t.shortcuts.duplicate],
    ["S", t.shortcuts.split],
    ["M", t.shortcuts.merge],
    ["Delete", t.shortcuts.remove],
    [`${mod} + Z`, t.shortcuts.undo],
    [`${mod} + Shift + Z`, t.shortcuts.redo],
    [`${mod} + S`, t.shortcuts.save],
    [`${mod} + K`, t.shortcuts.palette],
    ["?", t.shortcuts.help],
    ["Esc", t.shortcuts.close],
  ];
  return (
    <>
      <div className="fs-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={box}
        className="fs-dialog fs-glass"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-h`}
        onKeyDown={(e) => {
          trap(e);
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        data-testid="fs-shortcuts"
      >
        <div className="fs-row">
          <h2 id={`${id}-h`} className="fs-h2 fs-grow">
            {t.shortcuts.title}
          </h2>
          <button ref={close} type="button" className="fs-icon-key" onClick={onClose} aria-label={t.scene.close}>
            <X aria-hidden className="size-4" />
          </button>
        </div>
        <dl className="fs-keys">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>
                <kbd className="fs-kbd">{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  );
}
