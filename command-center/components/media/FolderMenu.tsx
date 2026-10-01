"use client";

import { forwardRef, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";

/**
 * The open folder's small menu: Rename, Delete folder. A button that opens a
 * list of two menu items; ↑/↓ move between them, Escape (or a tap outside)
 * closes it and puts focus back on the button. Choosing an item only opens
 * that item's dialog — nothing changes until it is confirmed there.
 */
export const FolderMenu = forwardRef<
  HTMLButtonElement,
  { label: string; renameLabel: string; deleteLabel: string; onRename: () => void; onDelete: () => void }
>(function FolderMenu({ label, renameLabel, deleteLabel, onRename, onDelete }, ref) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    items.current[0]?.focus();
    function onDown(e: PointerEvent) {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  function closeToButton() {
    setOpen(false);
    button.current?.focus();
  }

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const list = items.current.filter((x): x is HTMLButtonElement => Boolean(x));
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeToButton();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      list[e.key === "Home" ? 0 : list.length - 1]?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  const choose = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        ref={(el) => {
          button.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="press grid size-9 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-fg)]"
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          className="absolute right-0 top-[calc(100%+6px)] z-30 flex min-w-[12rem] flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-1.5 shadow-[var(--shadow-elevated)]"
        >
          <button
            ref={(el) => {
              items.current[0] = el;
            }}
            type="button"
            role="menuitem"
            onClick={choose(onRename)}
            className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[14px] text-[var(--color-fg)] hover:bg-[var(--color-panel-2)] focus-visible:bg-[var(--color-panel-2)]"
          >
            <Pencil className="size-4 text-[var(--color-muted)]" aria-hidden />
            {renameLabel}
          </button>
          <button
            ref={(el) => {
              items.current[1] = el;
            }}
            type="button"
            role="menuitem"
            onClick={choose(onDelete)}
            className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[14px] text-[var(--color-fail)] hover:bg-[var(--color-panel-2)] focus-visible:bg-[var(--color-panel-2)]"
          >
            <Trash2 className="size-4" aria-hidden />
            {deleteLabel}
          </button>
        </div>
      )}
    </div>
  );
});
