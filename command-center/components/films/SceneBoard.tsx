"use client";

import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { fmt } from "@/lib/i18n";
import type { FilmStudioDictionary } from "@/lib/i18n/film-studio";
import { clock, type Problem, type SceneDraft } from "@/lib/films";
import { problemText } from "@/components/films/SceneDetail";

const isField = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
const finePointer = () => typeof window !== "undefined" && window.matchMedia?.("(hover: hover) and (pointer: fine)").matches === true;

export interface BoardActions {
  select: (key: string) => void;
  open: (key: string) => void;
  edit: (key: string | null) => void;
  add: (after: number) => void;
  duplicate: (key: string) => void;
  split: (key: string) => void;
  merge: (key: string) => void;
  remove: (key: string) => void;
  moveTo: (key: string, to: number) => void;
  change: (key: string, p: Partial<SceneDraft>, field: string) => void;
}

/**
 * The storyboard as a grid of film cells (one view of a project; a node canvas may replace it, so it holds no project state of its
 * own: the scenes, the selection and every change come from useFilmProject through the canvas). A listbox with one tab stop:
 * arrows move by cell and by row, Home and End jump, Enter opens, F2 edits title and narration on the card, Alt+arrows and drag move a
 * scene, N adds, D duplicates, S splits, M merges with the next, Delete deletes (undo brings it back). Tilt follows a fine pointer unless the reader asked for less
 * motion; nothing glows that is not real.
 */
export function SceneBoard({
  t,
  scenes,
  selected,
  editing,
  readOnly,
  problemsOf,
  viewName,
  focusKey,
  actions,
  labelledHint,
}: {
  t: FilmStudioDictionary;
  scenes: readonly SceneDraft[];
  selected: string | null;
  editing: string | null;
  readOnly: boolean;
  problemsOf: (index: number) => Problem[];
  /** The View Transition name the selected cell carries while its detail is closed. */
  viewName: string | undefined;
  /** Set to a scene's key to move focus to its cell after the next render (then cleared by the caller's ref). */
  focusKey: React.MutableRefObject<string | null>;
  actions: BoardActions;
  labelledHint: string;
}) {
  const cells = useRef(new Map<string, HTMLElement>());
  const board = useRef<HTMLUListElement>(null);
  const dragKey = useRef<string | null>(null);
  const [drop, setDrop] = useState<{ key: string; side: "before" | "after" } | null>(null);

  useEffect(() => {
    const key = focusKey.current;
    if (!key) return;
    const el = cells.current.get(key);
    if (!el) return;
    focusKey.current = null;
    el.focus();
  });

  /** How many cells sit in the first row: the board's real column count, measured, so Up and Down move by a row. */
  const columns = () => {
    const els = [...(board.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])];
    if (els.length === 0) return 1;
    const top = els[0].offsetTop;
    return Math.max(1, els.filter((e) => e.offsetTop === top).length);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (isField(e.target) || editing || scenes.length === 0) return;
    const i = Math.max(0, scenes.findIndex((s) => s.key === selected));
    const go = (j: number) => {
      const k = scenes[Math.max(0, Math.min(scenes.length - 1, j))].key;
      actions.select(k);
      focusKey.current = k;
    };
    const cols = columns();
    if (e.altKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      if (readOnly) return;
      e.preventDefault();
      // Alt+Left/Up is one place earlier, Alt+Right/Down one place later: the order of the story, not the grid's rows.
      const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
      actions.moveTo(scenes[i].key, Math.max(0, Math.min(scenes.length - 1, i + step)));
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    const k = e.key;
    if (k === "ArrowRight") go(i + 1);
    else if (k === "ArrowLeft") go(i - 1);
    else if (k === "ArrowDown") go(i + cols);
    else if (k === "ArrowUp") go(i - cols);
    else if (k === "Home") go(0);
    else if (k === "End") go(scenes.length - 1);
    else if (k === "Enter" || k === " ") actions.open(scenes[i].key);
    else if (k === "F2" && !readOnly) actions.edit(scenes[i].key);
    else if ((k === "n" || k === "N") && !readOnly) actions.add(i);
    else if ((k === "d" || k === "D") && !readOnly) actions.duplicate(scenes[i].key);
    else if ((k === "s" || k === "S") && !readOnly) actions.split(scenes[i].key);
    else if ((k === "m" || k === "M") && !readOnly) actions.merge(scenes[i].key);
    else if ((k === "Delete" || k === "Backspace") && !readOnly) actions.remove(scenes[i].key);
    else return;
    e.preventDefault();
  };

  const tilt = (e: React.PointerEvent<HTMLElement>) => {
    if (!finePointer() || reducedMotion()) return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    // Written straight to the element: a tilt is presentation, and a re-render per pointer move would cost the board its frame rate.
    el.style.setProperty("--fs-ry", `${(x * 7).toFixed(2)}deg`);
    el.style.setProperty("--fs-rx", `${(-y * 5).toFixed(2)}deg`);
    el.style.setProperty("--fs-tx", `${(-x * 6).toFixed(1)}px`);
    el.style.setProperty("--fs-ty", `${(-y * 4).toFixed(1)}px`);
  };
  const untilt = (e: React.PointerEvent<HTMLElement>) => {
    for (const p of ["--fs-rx", "--fs-ry", "--fs-tx", "--fs-ty"]) e.currentTarget.style.removeProperty(p);
  };

  return (
    <ul ref={board} className="fs-board" role="listbox" aria-label={t.canvas.boardLabel} aria-describedby={labelledHint} onKeyDown={onKey} data-testid="fs-board">
      {scenes.map((s, i) => {
        const problems = problemsOf(i);
        const isSel = s.key === selected;
        return (
          <SceneCell
            key={s.key}
            t={t}
            scene={s}
            index={i}
            selected={isSel}
            focusable={isSel || (!selected && i === 0)}
            editing={editing === s.key}
            readOnly={readOnly}
            problems={problems}
            drop={drop?.key === s.key ? drop.side : null}
            viewName={isSel ? viewName : undefined}
            register={(el) => {
              if (el) cells.current.set(s.key, el);
              else cells.current.delete(s.key);
            }}
            onClick={() => (isSel ? actions.open(s.key) : actions.select(s.key))}
            onEdit={() => actions.edit(s.key)}
            onEditDone={() => {
              actions.edit(null);
              focusKey.current = s.key;
            }}
            onChange={(p, field) => actions.change(s.key, p, field)}
            onPointerMove={tilt}
            onPointerLeave={untilt}
            onDragStart={(e) => {
              dragKey.current = s.key;
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", s.key);
            }}
            onDragOver={(e) => {
              if (!dragKey.current || dragKey.current === s.key) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setDrop({ key: s.key, side: e.clientX < r.left + r.width / 2 ? "before" : "after" });
            }}
            onDragLeave={() => setDrop((d) => (d?.key === s.key ? null : d))}
            onDrop={(e) => {
              e.preventDefault();
              const from = dragKey.current;
              const side = drop?.key === s.key ? drop.side : "after";
              setDrop(null);
              dragKey.current = null;
              if (!from || from === s.key) return;
              const fi = scenes.findIndex((x) => x.key === from);
              let to = i + (side === "after" ? 1 : 0);
              if (fi < to) to -= 1;
              actions.moveTo(from, to);
            }}
            onDragEnd={() => {
              dragKey.current = null;
              setDrop(null);
            }}
          />
        );
      })}
    </ul>
  );
}

/** One film cell: the hologram (nothing is shot), its edge print, its title and its state. Light only from real state. */
function SceneCell({
  t,
  scene,
  index,
  selected,
  focusable,
  editing,
  readOnly,
  problems,
  drop,
  viewName,
  register,
  onClick,
  onEdit,
  onEditDone,
  onChange,
  onPointerMove,
  onPointerLeave,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: {
  t: FilmStudioDictionary;
  scene: SceneDraft;
  index: number;
  selected: boolean;
  focusable: boolean;
  editing: boolean;
  readOnly: boolean;
  problems: Problem[];
  drop: "before" | "after" | null;
  viewName: string | undefined;
  register: (el: HTMLElement | null) => void;
  onClick: () => void;
  onEdit: () => void;
  onEditDone: () => void;
  onChange: (p: Partial<SceneDraft>, field: string) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave: (e: React.PointerEvent<HTMLElement>) => void;
  onDragStart: (e: React.DragEvent<HTMLElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  const title = scene.title.trim();
  const status = problems.length > 0 ? problemText(t, problems[0], clock) : t.sceneStatus[scene.status];
  const lamp =
    problems.length > 0
      ? "warn"
      : scene.status === "generating" || scene.status === "queued"
        ? "work"
        : scene.status === "ready"
          ? "ready"
          : scene.status === "failed"
            ? "failed"
            : undefined;
  const label = fmt(t.canvas.cellLabel, { n: index + 1, title: title || t.canvas.untitled, length: fmt(t.scene.seconds, { n: scene.plannedSeconds }), status });
  return (
    <li
      ref={register}
      role="option"
      aria-selected={selected}
      aria-label={editing ? undefined : label}
      tabIndex={focusable ? 0 : -1}
      className="fs-cell"
      data-st={scene.status}
      data-problem={problems.length > 0 ? "true" : undefined}
      data-drop={drop ?? undefined}
      draggable={!readOnly && !editing}
      style={viewName ? { viewTransitionName: viewName } : undefined}
      onClick={onClick}
      onDoubleClick={() => !readOnly && onEdit()}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      data-testid="fs-cell"
    >
      <div className="fs-film" aria-hidden="true">
        <div className="fs-img">
          <div className="fs-holo fs-holo-layer" />
          <span className="fs-holo-no">{t.canvas.hologram}</span>
        </div>
      </div>
      <div className="fs-edge" aria-hidden="true">
        <span className="fs-no">{String(index + 1).padStart(2, "0")}</span>
        <span>{clock(scene.plannedSeconds)}</span>
        <span className="fs-grow" />
        {scene.shotCount > 1 && <span>×{scene.shotCount}</span>}
        {selected && !readOnly && !editing && (
          <button
            type="button"
            className="fs-cell-edit"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            aria-label={t.canvas.editOnCard}
            title={t.canvas.editOnCard}
          >
            <Pencil aria-hidden className="size-4" />
          </button>
        )}
      </div>
      {editing ? (
        <InlineEdit t={t} scene={scene} onChange={onChange} onDone={onEditDone} />
      ) : (
        <>
          <h3 className="fs-cell-title" data-empty={title ? undefined : "true"} aria-hidden="true">
            {title || t.canvas.untitled}
          </h3>
          <div className="fs-status" aria-hidden="true">
            <span className="fs-lamp" data-s={lamp} />
            <span>{status}</span>
          </div>
        </>
      )}
    </li>
  );
}

/** Title and narration, edited on the card itself (F2 or a double click). Enter in the title or Esc anywhere puts the card back. */
function InlineEdit({
  t,
  scene,
  onChange,
  onDone,
}: {
  t: FilmStudioDictionary;
  scene: SceneDraft;
  onChange: (p: Partial<SceneDraft>, field: string) => void;
  onDone: () => void;
}) {
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    first.current?.select();
  }, []);
  const keys = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === "Escape" || (e.key === "Enter" && e.currentTarget.tagName === "INPUT")) {
      e.preventDefault();
      onDone();
    }
  };
  return (
    <div className="fs-inline" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} data-testid="fs-inline">
      <input
        ref={first}
        className="ns-field"
        value={scene.title}
        placeholder={t.canvas.untitled}
        aria-label={t.scene.title}
        onChange={(e) => onChange({ title: e.target.value }, "title")}
        onKeyDown={keys}
      />
      <textarea
        className="ns-field"
        rows={3}
        value={scene.narration}
        placeholder={t.scene.narration}
        aria-label={t.scene.narration}
        onChange={(e) => onChange({ narration: e.target.value }, "narration")}
        onKeyDown={keys}
      />
      <button type="button" className="btn-quiet min-h-11 px-3 text-sm" onClick={onDone}>
        {t.canvas.doneEditing}
      </button>
    </div>
  );
}
