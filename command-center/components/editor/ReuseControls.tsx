"use client";

import { useEffect, useId, useRef, useState, type FocusEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  ListChecks,
  Lock,
  LockOpen,
  Paintbrush,
  Trash2,
  X,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { nextFocusIndex } from "@/lib/feedback";
import { countForm } from "@/lib/editorSilence";
import { SYNC_LANES, type SyncLane, type SyncLocks } from "@/lib/editorSync";
import {
  LOOK_GROUPS,
  groupsIn,
  type Look,
  type LookGroup,
  type LookPreset,
} from "@/lib/editorPasteLook";

const quietBtn = "btn-quiet inline-flex min-h-11 items-center gap-1.5 px-3 py-1.5 text-xs sm:min-h-0";
const note = "m-0 text-xs text-[var(--color-muted)]";
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Under the timeline: "Select several" (the touch way to build a selection; also a long press on an item), "Select
 * all after the playhead", and once two or more items are selected what can be done to all of them at once. Every
 * button is the same action as its key; a result or a refusal is said in the status line.
 */
export function SelectionBar({
  count,
  selectMode,
  onSelectMode,
  onForward,
  onClear,
  onRemove,
  onMove,
  onNudge,
  onCopy,
  onPasteLook,
  canMove,
  canNudge,
  status,
}: {
  count: number;
  selectMode: boolean;
  onSelectMode: (on: boolean) => void;
  onForward: () => void;
  onClear: () => void;
  onRemove: () => void;
  onMove: (by: -1 | 1) => void;
  onNudge: (frames: number) => void;
  onCopy: () => void;
  onPasteLook: () => void;
  canMove: boolean;
  canNudge: boolean;
  status: string | null;
}) {
  const { t, locale } = useI18n();
  const rs = t.editor.reuse.select;
  const hintId = useId();
  const many = count > 1;
  return (
    <div role="group" aria-label={rs.group} aria-describedby={hintId} className="flex flex-col gap-1.5" data-testid="selection-bar" data-editor-timeline="">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${quietBtn} ${selectMode ? "border-[var(--color-primary)] text-[var(--color-fg)]" : ""}`}
          aria-pressed={selectMode}
          onClick={() => onSelectMode(!selectMode)}
        >
          <ListChecks className="size-3.5" aria-hidden />
          {selectMode ? rs.done : rs.mode}
        </button>
        <button type="button" className={quietBtn} onClick={onForward}>
          <ChevronsRight className="size-3.5" aria-hidden />
          {rs.forward}
        </button>
        {many ? (
          <>
            <span className="ns-chip text-xs font-semibold" data-testid="selection-count">
              {fmt(rs.count[countForm(count, locale)], { n: count })}
            </span>
            <button type="button" className={quietBtn} onClick={onRemove} aria-keyshortcuts="Delete">
              <Trash2 className="size-3.5" aria-hidden />
              {rs.remove}
            </button>
            <button type="button" className={quietBtn} onClick={() => onMove(-1)} aria-disabled={!canMove || undefined}>
              <ChevronsLeft className="size-3.5" aria-hidden />
              {rs.earlier}
            </button>
            <button type="button" className={quietBtn} onClick={() => onMove(1)} aria-disabled={!canMove || undefined}>
              <ChevronsRight className="size-3.5" aria-hidden />
              {rs.later}
            </button>
            <button type="button" className={quietBtn} onClick={() => onNudge(-1)} aria-disabled={!canNudge || undefined} aria-keyshortcuts="Alt+ArrowLeft">
              <ArrowLeft className="size-3.5" aria-hidden />
              {rs.nudgeLeft}
            </button>
            <button type="button" className={quietBtn} onClick={() => onNudge(1)} aria-disabled={!canNudge || undefined} aria-keyshortcuts="Alt+ArrowRight">
              <ArrowRight className="size-3.5" aria-hidden />
              {rs.nudgeRight}
            </button>
            <button type="button" className={quietBtn} onClick={onCopy} aria-keyshortcuts="Control+C">
              <Copy className="size-3.5" aria-hidden />
              {rs.copy}
            </button>
            <button type="button" className={quietBtn} onClick={onPasteLook} aria-haspopup="dialog" aria-keyshortcuts="Control+Alt+V">
              <Paintbrush className="size-3.5" aria-hidden />
              {t.editor.reuse.look.paste}
            </button>
            <button type="button" className={quietBtn} onClick={onClear}>
              <X className="size-3.5" aria-hidden />
              {rs.clear}
            </button>
          </>
        ) : null}
      </div>
      <p id={hintId} className={note}>
        {selectMode ? rs.modeOn : rs.hint}
      </p>
      {status ? (
        <p role="status" className="m-0 text-xs" data-testid="selection-status">
          {status}
        </p>
      ) : null}
    </div>
  );
}

/** The four lanes that follow ripple edits, each with its lock (pressed = locked: keeps its times). */
export function SyncLockBar({ locks, onLocks }: { locks: SyncLocks; onLocks: (l: SyncLocks) => void }) {
  const { t } = useI18n();
  const sy = t.editor.reuse.sync;
  const hintId = useId();
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0" aria-describedby={hintId} data-testid="sync-lock" data-editor-timeline="">
      <legend className="sr-only">{sy.group}</legend>
      <div className="flex flex-wrap items-center gap-1.5">
        <span aria-hidden className="text-xs text-[var(--color-muted)]">
          {sy.group}
        </span>
        {SYNC_LANES.map((lane: SyncLane) => {
          const on = locks[lane];
          return (
            <button
              key={lane}
              type="button"
              aria-pressed={on}
              aria-label={fmt(sy.lock, { lane: sy.lanes[lane] })}
              onClick={() => onLocks({ ...locks, [lane]: !on })}
              data-lane={lane}
              className={`ns-chip min-h-11 gap-1 text-xs sm:min-h-0 ${on ? "border-[var(--color-primary)] text-[var(--color-fg)]" : ""}`}
            >
              {on ? <Lock className="size-3.5" aria-hidden /> : <LockOpen className="size-3.5" aria-hidden />}
              <span>{sy.lanes[lane]}</span>
              <span aria-hidden className="text-[var(--color-muted)]">
                · {on ? sy.locked : sy.follows}
              </span>
            </button>
          );
        })}
      </div>
      <p id={hintId} className={note}>
        {sy.hint}
      </p>
    </fieldset>
  );
}

/** Copy look / Paste look… for the selected clip (in its inspector). */
export function LookTools({ onCopy, onPaste }: { onCopy: () => void; onPaste: () => void }) {
  const { t } = useI18n();
  const lk = t.editor.reuse.look;
  return (
    <div className="flex flex-wrap gap-2" data-testid="look-tools">
      <button type="button" className={quietBtn} onClick={onCopy}>
        <Copy className="size-3.5" aria-hidden />
        {lk.copy}
      </button>
      <button type="button" className={quietBtn} onClick={onPaste} aria-haspopup="dialog" aria-keyshortcuts="Control+Alt+V">
        <Paintbrush className="size-3.5" aria-hidden />
        {lk.paste}
      </button>
    </div>
  );
}

export type LookSource = { kind: "copied"; look: Look } | { kind: "preset"; name: string; look: Look };

/**
 * Paste attributes: where the look comes from (the copied clip, or a preset), which groups to paste (only those the
 * look has; each replaces that group on the clips), and the presets (save the copied look under a name, delete one).
 * A modal dialog: focus stays inside it, Escape closes it, and focus goes back to what opened it.
 */
export function PasteLookDialog({
  open,
  onClose,
  copied,
  copiedFrom,
  presets,
  targets,
  onPaste,
  onSavePreset,
  onDeletePreset,
}: {
  open: boolean;
  onClose: () => void;
  copied: Look | null;
  /** The number of the clip the look was copied from, when known. */
  copiedFrom: number | null;
  presets: readonly LookPreset[];
  /** How many picture clips it would paste on. */
  targets: number;
  onPaste: (look: Look, groups: LookGroup[]) => void;
  /** Saves the copied look; returns the sentence to say (saved, or why not). */
  onSavePreset: (name: string) => string;
  onDeletePreset: (name: string) => string;
}) {
  const { t, locale } = useI18n();
  const lk = t.editor.reuse.look;
  const titleId = useId();
  const noteId = useId();
  const nameId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const [from, setFrom] = useState<string>("copied");
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [name, setName] = useState("");
  const [said, setSaid] = useState<string | null>(null);

  const source: Look | null =
    from === "copied" ? copied : (presets.find((p) => `preset:${p.name}` === from)?.look ?? null);
  const groups = source ? groupsIn(source) : [];

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    setFrom(copied ? "copied" : presets[0] ? `preset:${presets[0].name}` : "copied");
    setSaid(null);
    setName("");
    // focus the first control once the dialog is drawn
    setTimeout(() => (panel.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panel.current)?.focus(), 0);
    return () => {
      const back = opener.current;
      if (back instanceof HTMLElement && document.contains(back)) setTimeout(() => back.focus(), 0);
    };
    // the source list is read when the dialog opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // Each new source starts with every group it has ticked.
  useEffect(() => {
    setTicked(Object.fromEntries(groups.map((g) => [g, true])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, open]);

  if (!open || typeof document === "undefined") return null;

  function keepFocus(e: MouseEvent<HTMLElement>) {
    if ((e.target as HTMLElement).closest(FOCUSABLE) || (e.target as HTMLElement).closest("label")) return;
    e.preventDefault();
    panel.current?.focus();
  }
  function onBlur(e: FocusEvent<HTMLElement>) {
    if (e.relatedTarget) return;
    setTimeout(() => {
      if (panel.current && !panel.current.contains(document.activeElement)) panel.current.focus();
    }, 0);
  }
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const next = nextFocusIndex(items.indexOf(document.activeElement as HTMLElement), items.length, e.shiftKey);
    if (next < 0) return;
    e.preventDefault();
    items[next].focus();
  }
  const chosen = groups.filter((g) => ticked[g]);
  const canPaste = Boolean(source) && chosen.length > 0 && targets > 0;

  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-end justify-center p-4 sm:items-center" onKeyDown={onKeyDown}>
      <div aria-hidden className="scrim-enter absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={noteId}
        tabIndex={-1}
        onMouseDown={keepFocus}
        onBlur={onBlur}
        data-testid="paste-look-dialog"
        className="sheet-enter relative flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-5 shadow-[var(--shadow-elevated)] outline-none"
      >
        <div className="flex items-start gap-3">
          <h2 id={titleId} className="m-0 min-w-0 flex-1 text-[15px] font-semibold text-[var(--color-fg)]">
            {lk.title}
          </h2>
          <button type="button" onClick={onClose} aria-label={lk.close} className="ns-chip min-w-11 shrink-0 justify-center px-0">
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <p id={noteId} className={note}>
          {targets > 0 ? lk.groupHint : lk.noTargets}
        </p>

        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1 text-xs font-semibold text-[var(--color-fg)]">{lk.from}</legend>
          {copied ? (
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-0">
              <input type="radio" name={`${titleId}-from`} checked={from === "copied"} onChange={() => setFrom("copied")} />
              {copiedFrom ? `${lk.copied} · ${fmt(lk.copiedFrom, { n: copiedFrom })}` : lk.copied}
            </label>
          ) : (
            <p className={note}>{lk.noSource}</p>
          )}
          {presets.map((p) => (
            <div key={p.name} className="flex items-center gap-2">
              <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm sm:min-h-0">
                <input
                  type="radio"
                  name={`${titleId}-from`}
                  checked={from === `preset:${p.name}`}
                  onChange={() => setFrom(`preset:${p.name}`)}
                />
                <span className="truncate">{p.name}</span>
              </label>
              <button
                type="button"
                className="ns-chip min-w-11 justify-center px-0"
                aria-label={fmt(lk.del, { name: p.name })}
                onClick={() => {
                  setSaid(onDeletePreset(p.name));
                  if (from === `preset:${p.name}`) setFrom("copied");
                }}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </div>
          ))}
        </fieldset>

        <fieldset className="m-0 flex flex-col gap-1 border-0 p-0" data-testid="paste-look-groups">
          <legend className="mb-1 text-xs font-semibold text-[var(--color-fg)]">{lk.groups}</legend>
          {source && !groups.length ? <p className={note}>{lk.nothingIn}</p> : null}
          {LOOK_GROUPS.filter((g) => groups.includes(g)).map((g) => (
            <label key={g} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-0">
              <input type="checkbox" checked={Boolean(ticked[g])} onChange={(e) => setTicked((x) => ({ ...x, [g]: e.target.checked }))} />
              {lk.group[g]}
            </label>
          ))}
        </fieldset>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary inline-flex min-h-11 items-center gap-1.5 px-3 py-1.5 text-xs"
            aria-disabled={!canPaste || undefined}
            onClick={() => {
              if (!canPaste || !source) return;
              onPaste(source, chosen);
            }}
          >
            <Paintbrush className="size-3.5" aria-hidden />
            {fmt(lk.to[countForm(targets, locale)], { n: targets })}
          </button>
          <button type="button" className={quietBtn} onClick={onClose}>
            {lk.cancel}
          </button>
        </div>

        <div className="flex flex-col gap-1.5 border-t border-[var(--color-border)] pt-3">
          <h3 className="m-0 text-xs font-semibold text-[var(--color-fg)]">{lk.presets}</h3>
          {!presets.length ? <p className={note}>{lk.noPresets}</p> : null}
          {copied ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setSaid(onSavePreset(name));
              }}
            >
              <label htmlFor={nameId} className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
                {lk.presetName}
                <input
                  id={nameId}
                  type="text"
                  value={name}
                  maxLength={60}
                  onChange={(e) => setName(e.target.value)}
                  className="min-h-11 rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 text-sm text-[var(--color-fg)] sm:min-h-9"
                />
              </label>
              <button type="submit" className={quietBtn}>
                {lk.save}
              </button>
            </form>
          ) : null}
          <p className={note}>{lk.presetsNote}</p>
          {said ? (
            <p role="status" className="m-0 text-xs" data-testid="preset-status">
              {said}
            </p>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
