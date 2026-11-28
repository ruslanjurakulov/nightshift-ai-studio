"use client";

import Link from "next/link";
import { flushSync } from "react-dom";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, Command, Keyboard, Lock, Plus, Redo2, Undo2, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { filmStudioStrings, type FilmStudioDictionary } from "@/lib/i18n/film-studio";
import { clock, type FilmView } from "@/lib/films";
import { StationTrack } from "@/components/films/StationTrack";
import { FilmTimeline } from "@/components/films/FilmTimeline";
import { SceneBoard } from "@/components/films/SceneBoard";
import { SceneDetail, problemText, type LibraryPicture } from "@/components/films/SceneDetail";
import { ProjectPanel, type LibraryCharacter } from "@/components/films/ProjectPanel";
import { FilmErrorNotice } from "@/components/films/FilmErrorNotice";
import { CommandPalette, ShortcutsHelp, type CanvasCommand } from "@/components/films/CanvasOverlays";
import { useFilmProject, type FilmProject } from "@/components/films/useFilmProject";
import { costText, readCheck, refusalText, setsText, type PlanCheck, type Refusal } from "@/lib/brain/film-plan-view";

const isField = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
const narrowNow = () => typeof window !== "undefined" && window.matchMedia?.("(max-width: 1023.98px)").matches === true;
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** Run a state change inside a View Transition where the browser has one and the reader has not asked for less motion. */
function withTransition(change: () => void) {
  if (typeof document !== "undefined" && "startViewTransition" in document && typeof document.startViewTransition === "function" && !reducedMotion()) {
    document.startViewTransition(() => flushSync(change));
  } else {
    change();
  }
}

/**
 * Studio → Projects, one project (docs/FILM_STUDIO.md, P6 for drafts). The data and its state are useFilmProject's; this file lays
 * them out: the header with the station track, the storyboard (SceneBoard), the inspector (a scene, or the project and its
 * references), the timeline, and the dock.
 *
 * The dock owns its own band. On a wide screen it is the board's second grid row, so the board's scroll area ends above it; on a
 * narrow one it is the last band in the page's flow. It never floats over a scene. Its Start key is off with the reason beside it:
 * pricing (P2) is not built, so there is no number, no price and no quote on this screen (CLAUDE.md rules 3 and 5).
 */
export function FilmCanvas({
  initial,
  canEdit,
  pictures,
  characters,
  listHref,
}: {
  initial: FilmView;
  canEdit: boolean;
  pictures: readonly LibraryPicture[];
  characters: readonly LibraryCharacter[];
  listHref: string;
}) {
  const { locale } = useI18n();
  const t = filmStudioStrings(locale);
  const p = useFilmProject(initial, canEdit);
  return <CanvasView t={t} p={p} pictures={pictures} characters={characters} listHref={listHref} canEdit={canEdit} />;
}

export function CanvasView({
  t,
  p,
  pictures,
  characters,
  listHref,
  canEdit,
}: {
  t: FilmStudioDictionary;
  p: FilmProject;
  pictures: readonly LibraryPicture[];
  characters: readonly LibraryCharacter[];
  listHref: string;
  canEdit: boolean;
}) {
  const ids = useId();
  const { view, draft, limits, readOnly: projectReadOnly, problems, dirty, saving, saveState, conflict, failure } = p;
  // While Nightshift AI writes this project's storyboard (or another tab's plan of it is followed, or a lost press is confirmed),
  // the canvas is read-only: an edit made meanwhile would be superseded by the plan's save, or would supersede the plan (Lens M3).
  const [aiBusy, setAiBusy] = useState(false);
  const readOnly = projectReadOnly || aiBusy;
  const [selected, setSelected] = useState<string | null>(draft.scenes[0]?.key ?? null);
  const [sheet, setSheet] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [archiveAsk, setArchiveAsk] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [showProblems, setShowProblems] = useState(false);
  const focusKey = useRef<string | null>(null);
  const commandsButton = useRef<HTMLButtonElement>(null);

  const total = draft.scenes.reduce((s, x) => s + x.plannedSeconds, 0);
  const selIndex = draft.scenes.findIndex((s) => s.key === selected);
  const sel = selIndex >= 0 ? draft.scenes[selIndex] : null;
  const mod = typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform) ? "⌘" : "Ctrl";

  // A selection that no longer exists (undo, reload, delete elsewhere) falls to the first scene.
  useEffect(() => {
    if (selected && !draft.scenes.some((s) => s.key === selected)) setSelected(draft.scenes[0]?.key ?? null);
  }, [draft.scenes, selected]);

  // ── actions, each with what it says to a screen reader ─────────────────────

  const addScene = useCallback(
    (after: number | null) => {
      const r = p.addScene(after);
      if (!r) return;
      setSelected(r.key);
      focusKey.current = r.key;
      setAnnounce(fmt(t.canvas.added, { n: r.index + 1 }));
    },
    [p, t],
  );
  const duplicate = useCallback(
    (key: string) => {
      const r = p.duplicate(key);
      if (!r) return;
      setSelected(r.key);
      focusKey.current = r.key;
      setAnnounce(fmt(t.canvas.added, { n: r.index + 1 }));
    },
    [p, t],
  );
  const remove = useCallback(
    (key: string) => {
      const active = document.activeElement;
      const r = p.remove(key);
      if (!r) return;
      setSelected(r.next);
      focusKey.current = r.next;
      setSheet(false);
      setAnnounce(fmt(t.canvas.removed, { n: r.index + 1 }));
      if (!r.next && active) {
        requestAnimationFrame(() => {
          // Keep the empty board reachable without overriding a later focus move.
          if (!active.isConnected && document.activeElement === document.body) commandsButton.current?.focus();
        });
      }
    },
    [p, t],
  );
  const moveTo = useCallback(
    (key: string, to: number) => {
      const r = p.moveTo(key, to);
      if (!r) return;
      focusKey.current = key;
      setAnnounce(fmt(t.canvas.moved, { from: r.from + 1, to: r.to + 1 }));
    },
    [p, t],
  );
  const undo = useCallback(() => {
    if (p.undo()) setAnnounce(t.canvas.undone);
  }, [p, t]);
  const redo = useCallback(() => {
    if (p.redo()) setAnnounce(t.canvas.redone);
  }, [p, t]);
  const split = useCallback(
    (key: string) => {
      const r = p.split(key);
      if (!r) return;
      if ("refused" in r) {
        setAnnounce(r.refused === "full" ? fmt(t.problems.too_many_scenes, { n: limits.max_scenes }) : fmt(t.canvas.splitTooShort, { n: limits.scene_seconds_min * 2 }));
        return;
      }
      setSelected(r.key);
      focusKey.current = r.key;
      setAnnounce(fmt(t.canvas.splitDone, { n: r.index + 1 }));
    },
    [p, t, limits],
  );
  const merge = useCallback(
    (key: string) => {
      const r = p.merge(key);
      if (!r) return;
      if ("refused" in r) {
        setAnnounce(r.refused === "last" ? t.canvas.mergeLast : r.refused === "takes" ? t.canvas.mergeTakes : fmt(t.canvas.mergeTooLong, { n: limits.scene_seconds_max }));
        return;
      }
      setSelected(r.key);
      focusKey.current = r.key;
      setAnnounce(fmt(t.canvas.mergeDone, { n: r.index + 1 }));
    },
    [p, t, limits],
  );
  const save = useCallback(async () => {
    const r = await p.save();
    if (r === "fix") setShowProblems(true);
  }, [p]);
  // Stable across renders: the AI writer's wait for another tab's plan is a timer keyed on it. Never a reload over unsaved changes:
  // they stay on screen, and the next save meets the project's newer version through the save's own conflict path.
  const { reload } = p;
  const dirtyNow = useRef(dirty);
  useEffect(() => {
    dirtyNow.current = dirty;
  }, [dirty]);
  const onAiWritten = useCallback(async () => {
    if (dirtyNow.current) return;
    await reload();
  }, [reload]);

  const openScene = useCallback(
    (key: string) => {
      if (narrowNow()) {
        withTransition(() => {
          setSelected(key);
          setSheet(true);
        });
      } else {
        withTransition(() => setSelected(key));
        requestAnimationFrame(() => document.getElementById(`${ids}-scene-h`)?.focus());
      }
    },
    [ids],
  );
  const closeSheet = useCallback(() => {
    if (selected) focusKey.current = selected;
    withTransition(() => setSheet(false));
  }, [selected]);

  // Ctrl/Cmd+K, +S, +Z and "?" anywhere on the canvas. Captured, so the app-wide palette does not also open on this page (its search
  // is one command in this palette).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const m = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (m && k === "k") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setHelp(false);
        setPalette((x) => !x);
      } else if (m && k === "s") {
        e.preventDefault();
        void save();
      } else if (m && (k === "y" || (k === "z" && e.shiftKey)) && !isField(e.target) && !readOnly) {
        e.preventDefault();
        redo();
      } else if (m && k === "z" && !e.shiftKey && !isField(e.target) && !readOnly) {
        e.preventDefault();
        undo();
      } else if (e.key === "?" && !isField(e.target) && !palette) {
        e.preventDefault();
        setHelp(true);
      } else if (e.key === "Escape" && sheet && !palette && !help) {
        e.preventDefault();
        closeSheet();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [save, undo, redo, readOnly, palette, help, sheet, closeSheet]);

  // Unsaved work is never lost without a question.
  useEffect(() => {
    if (!dirty || projectReadOnly) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = t.canvas.leaveWarning;
      return t.canvas.leaveWarning;
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, projectReadOnly, t]);

  // ── the palette's commands: every action in one or two keystrokes, each disabled with its reason ─────

  const or = (...r: (string | false | undefined)[]) => r.find((x): x is string => typeof x === "string");
  // While Nightshift AI writes, the lock's own reason: the project CAN be changed, just not until the storyboard is in (Pixel 12).
  const ro = (projectReadOnly && t.palette.readOnly) || (aiBusy && t.canvas.ai.locked);
  const full = draft.scenes.length >= limits.max_scenes && fmt(t.problems.too_many_scenes, { n: limits.max_scenes });
  const commands: CanvasCommand[] = [
    { id: "add", label: t.canvas.addScene, keys: "N", disabledReason: or(ro, full), run: () => addScene(selIndex >= 0 ? selIndex : null) },
    { id: "dup", label: t.canvas.duplicate, keys: "D", disabledReason: or(ro, !sel && t.palette.needsScene, full), run: () => sel && duplicate(sel.key) },
    { id: "split", label: t.canvas.split, keys: "S", disabledReason: or(ro, !sel && t.palette.needsScene, full, !!sel && sel.plannedSeconds < limits.scene_seconds_min * 2 && fmt(t.canvas.splitTooShort, { n: limits.scene_seconds_min * 2 })), run: () => sel && split(sel.key) },
    {
      id: "merge",
      label: t.canvas.merge,
      keys: "M",
      disabledReason: or(
        ro,
        !sel && t.palette.needsScene,
        !!sel && selIndex === draft.scenes.length - 1 && t.canvas.mergeLast,
        !!sel && !!draft.scenes[selIndex + 1]?.hasTakes && t.canvas.mergeTakes,
        !!sel && !!draft.scenes[selIndex + 1] && sel.plannedSeconds + draft.scenes[selIndex + 1].plannedSeconds > limits.scene_seconds_max && fmt(t.canvas.mergeTooLong, { n: limits.scene_seconds_max }),
      ),
      run: () => sel && merge(sel.key),
    },
    { id: "edit", label: t.canvas.editOnCard, keys: "F2", disabledReason: or(ro, !sel && t.palette.needsScene), run: () => sel && setEditing(sel.key) },
    { id: "earlier", label: t.scene.moveUp, keys: "Alt ←", disabledReason: or(ro, (!sel || selIndex === 0) && t.palette.needsScene), run: () => sel && moveTo(sel.key, selIndex - 1) },
    { id: "later", label: t.scene.moveDown, keys: "Alt →", disabledReason: or(ro, (!sel || selIndex === draft.scenes.length - 1) && t.palette.needsScene), run: () => sel && moveTo(sel.key, selIndex + 1) },
    { id: "remove", label: t.scene.remove, keys: "Delete", disabledReason: or(ro, !sel && t.palette.needsScene, !!sel?.hasTakes && t.scene.removeHasTakes), run: () => sel && remove(sel.key) },
    { id: "undo", label: t.canvas.undo, keys: `${mod} Z`, disabledReason: or(ro, !p.canUndo && t.canvas.nothingToUndo), run: undo },
    { id: "redo", label: t.canvas.redo, keys: `${mod} ⇧ Z`, disabledReason: or(ro, !p.canRedo && t.canvas.nothingToRedo), run: redo },
    { id: "save", label: t.canvas.save, keys: `${mod} S`, disabledReason: or(ro, conflict && t.canvas.saveState.elsewhere, !dirty && t.canvas.saveState.saved), run: () => void save() },
    { id: "archive", label: t.canvas.archive, disabledReason: or(ro), run: () => setArchiveAsk(true) },
    { id: "help", label: t.shortcuts.title, keys: "?", run: () => setHelp(true) },
    { id: "app", label: t.palette.appSearch, run: () => window.dispatchEvent(new Event("chronos:palette-open")) },
  ];

  // ── what the screen says ───────────────────────────────────────────────────

  const lamp = aiBusy && !projectReadOnly ? "work" : saveState === "saved" ? "ready" : saveState === "saving" ? "work" : saveState === "elsewhere" ? "failed" : saveState === "fix" || saveState === "unsaved" ? "warn" : undefined;
  const stateText = projectReadOnly ? t.canvas.readOnlyState : aiBusy ? t.canvas.ai.locked : t.canvas.saveState[saveState];
  const sceneProblems = (i: number) => problems.filter((x) => x.scene === i);
  const filmProblems = problems.filter((x) => x.scene === undefined);
  const facts = fmt(t.canvas.facts, {
    scenes: draft.scenes.length,
    planned: clock(total),
    target: clock(draft.settings.targetSeconds),
    language: t.languages[draft.settings.language],
  });

  const saveBar = (
    <div className="fs-dock-save">
      <span className="fs-lamp" data-s={lamp} aria-hidden="true" />
      <span className="text-sm" data-testid="fs-save-state">
        {stateText}
      </span>
      {!readOnly && (
        <>
          <button type="button" className="fs-icon-key" aria-label={t.canvas.undo} onClick={undo} disabled={!p.canUndo} title={p.canUndo ? t.canvas.undo : t.canvas.nothingToUndo}>
            <Undo2 aria-hidden className="size-4" />
          </button>
          <button type="button" className="fs-icon-key" aria-label={t.canvas.redo} onClick={redo} disabled={!p.canRedo} title={p.canRedo ? t.canvas.redo : t.canvas.nothingToRedo} data-testid="fs-redo">
            <Redo2 aria-hidden className="size-4" />
          </button>
          <button type="button" className="btn-quiet min-h-11 px-3 text-sm" onClick={() => void save()} disabled={!dirty || saving || conflict} data-testid="fs-save">
            {saving ? t.canvas.saving : t.canvas.save}
          </button>
        </>
      )}
    </div>
  );

  // The quote side of the dock: P2 (pricing) is not built, so there is no number and Start is off, with its reason (rules 3, 5).
  const quote = (why: string) => (
    <div className="fs-dock-quote">
      <p id={why} className="fs-dock-why">
        {t.dock.notLive}
      </p>
      <button type="button" className="fs-start" disabled aria-describedby={why} data-testid="fs-start">
        <Lock aria-hidden className="size-4" />
        {t.dock.start}
      </button>
    </div>
  );

  const detail = (headingId: string) =>
    sel ? (
      <SceneDetail
        t={t}
        scene={sel}
        index={selIndex}
        count={draft.scenes.length}
        next={draft.scenes[selIndex + 1] ?? null}
        limits={limits}
        problems={sceneProblems(selIndex)}
        readOnly={readOnly}
        pictures={pictures}
        onChange={(patch, field) => p.changeScene(sel.key, patch, field)}
        onMove={(dir) => moveTo(sel.key, selIndex + dir)}
        onRemove={() => remove(sel.key)}
        onDuplicate={() => duplicate(sel.key)}
        onSplit={() => split(sel.key)}
        onMerge={() => merge(sel.key)}
        headingId={headingId}
      />
    ) : null;

  const project = (
    <ProjectPanel
      t={t}
      film={view.film}
      settings={draft.settings}
      refs={draft.refs}
      limits={limits}
      problems={filmProblems}
      readOnly={readOnly}
      pictures={pictures}
      characters={characters}
      onSettings={p.changeSettings}
      onRefs={p.setRefs}
    />
  );

  return (
    <div className="fs-root fs-canvas-page">
      <div className="fs-sr" aria-live="polite">
        {announce}
      </div>
      <div className="fs-sr" aria-live="polite" data-testid="fs-save-live">
        {saveState === "saving" ? "" : stateText}
      </div>
      <div className="fs-stage">
        <section className="fs-board-cell" aria-labelledby={`${ids}-title`}>
          <div className="fs-board-scroll">
            <header className="fs-head">
              <Link href={listHref} className="fs-back">
                <ArrowLeft aria-hidden className="size-4" />
                {t.canvas.back}
              </Link>
              <div className="fs-head-top">
                <div className="flex min-w-0 flex-col gap-1">
                  <h1 id={`${ids}-title`} className="fs-title">
                    {draft.settings.title.trim() || view.film.title}
                  </h1>
                  <p className="fs-small tnum">{facts}</p>
                </div>
                <div className="fs-row">
                  <button ref={commandsButton} type="button" className="btn-quiet min-h-11 px-3 text-sm" onClick={() => setPalette(true)} aria-keyshortcuts="Control+K Meta+K" data-testid="fs-open-palette">
                    <Command aria-hidden className="size-4" />
                    {t.palette.title}
                  </button>
                  <button type="button" className="fs-icon-key" onClick={() => setHelp(true)} aria-label={t.shortcuts.title} title={t.shortcuts.title} aria-keyshortcuts="?">
                    <Keyboard aria-hidden className="size-4" />
                  </button>
                  {!readOnly && (
                    <button type="button" className="btn-quiet min-h-11 px-3 text-sm" onClick={() => setArchiveAsk(true)} data-testid="fs-archive">
                      {t.canvas.archive}
                    </button>
                  )}
                </div>
              </div>
              <StationTrack t={t} film={view.film} />
              {archiveAsk && !readOnly && (
                <div className="fs-confirm" role="alertdialog" aria-labelledby={`${ids}-arch`} aria-describedby={`${ids}-arch-b`}>
                  <h2 id={`${ids}-arch`} className="fs-h3">
                    {t.canvas.archiveTitle}
                  </h2>
                  <p id={`${ids}-arch-b`} className="fs-small">
                    {t.canvas.archiveBody} {dirty ? t.canvas.archiveDirty : ""}
                  </p>
                  <div className="fs-row">
                    <button
                      type="button"
                      className="btn-primary min-h-11 px-4 text-sm"
                      onClick={async () => {
                        await p.archive();
                        setArchiveAsk(false);
                      }}
                      disabled={p.archiving}
                      autoFocus
                    >
                      {p.archiving ? t.canvas.archiving : t.canvas.archiveYes}
                    </button>
                    <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={() => setArchiveAsk(false)} disabled={p.archiving}>
                      {t.canvas.archiveNo}
                    </button>
                  </div>
                </div>
              )}
              <Notices t={t} view={view} canEdit={canEdit} conflict={conflict} failure={failure} onReload={() => void p.reload()} />
              {p.recovered === "restored" && (
                <div className="fs-notice" data-tone="human" role="status" data-testid="fs-recovered">
                  <span className="fs-lamp" data-s="human" aria-hidden="true" />
                  <div className="flex min-w-0 flex-col gap-2">
                    <p>{t.canvas.recovered}</p>
                    <button type="button" className="btn-quiet min-h-11 self-start px-4 text-sm" onClick={p.discardRecovered}>
                      {t.canvas.recoveredOk}
                    </button>
                  </div>
                </div>
              )}
              {p.recovered && p.recovered !== "restored" && (
                <div className="fs-notice" data-tone="warn" role="alert" data-testid="fs-recovered-stale">
                  <span className="fs-lamp" data-s="warn" aria-hidden="true" />
                  <div className="flex min-w-0 flex-col gap-2">
                    <p>{t.canvas.recoveredStale}</p>
                    <div className="fs-row">
                      <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={p.applyStale}>
                        {t.canvas.applyStale}
                      </button>
                      <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={p.discardRecovered}>
                        {t.canvas.discardStale}
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {showProblems && filmProblems.length > 0 && (
                <div className="fs-notice" data-tone="warn" role="alert">
                  <span className="fs-lamp" data-s="warn" aria-hidden="true" />
                  <p>{filmProblems.map((x) => problemText(t, x, clock)).join(" ")}</p>
                </div>
              )}
            </header>

            <div className="fs-board-tools">
              <h2 className="fs-h2">{t.canvas.board}</h2>
              <div className="fs-row">
                {!readOnly && (
                  <button
                    type="button"
                    className="btn-primary min-h-11 px-4 text-sm"
                    onClick={() => addScene(selIndex >= 0 ? selIndex : null)}
                    disabled={draft.scenes.length >= limits.max_scenes}
                    data-testid="fs-add"
                  >
                    <Plus aria-hidden className="size-4" />
                    {t.canvas.addScene}
                  </button>
                )}
              </div>
            </div>
            <AiWriter
              t={t}
              filmId={view.film.id}
              version={view.film.version}
              canEdit={canEdit}
              readOnly={projectReadOnly}
              hasScenes={view.scenes.length > 0 || draft.scenes.length > 0}
              dirty={dirty}
              reasonId={`${ids}-ai`}
              onWritten={onAiWritten}
              onBusy={setAiBusy}
            />

            {draft.scenes.length === 0 ? (
              <div className="fs-board-empty" data-testid="fs-board-empty">
                <p className="m-0 text-base">{t.canvas.empty}</p>
                {!readOnly && (
                  <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={() => addScene(null)}>
                    <Plus aria-hidden className="size-4" />
                    {t.canvas.addScene}
                  </button>
                )}
              </div>
            ) : (
              <>
                <p id={`${ids}-hint`} className="fs-sr">
                  {readOnly ? t.canvas.keyboardHint : t.canvas.dragHint}
                </p>
                <SceneBoard
                  t={t}
                  scenes={draft.scenes}
                  selected={selected}
                  editing={editing}
                  readOnly={readOnly}
                  problemsOf={sceneProblems}
                  viewName={sheet ? undefined : "fs-scene"}
                  focusKey={focusKey}
                  labelledHint={`${ids}-hint`}
                  actions={{
                    select: setSelected,
                    open: openScene,
                    edit: (k) => {
                      if (k) setSelected(k);
                      setEditing(k);
                    },
                    add: (i) => addScene(i),
                    duplicate,
                    split,
                    merge,
                    remove,
                    moveTo,
                    change: p.changeScene,
                  }}
                />
              </>
            )}
          </div>
          <div className="fs-dock fs-dock-wide" role="region" aria-label={t.dock.label} data-testid="fs-dock">
            {saveBar}
            {quote(`${ids}-why`)}
          </div>
        </section>

        <aside className="fs-inspector fs-inspector-wide fs-glass" aria-label={sel ? fmt(t.scene.heading, { n: selIndex + 1 }) : t.canvas.settings}>
          {sel ? (
            <>
              <button type="button" className="btn-quiet min-h-11 self-start px-3 text-sm" onClick={() => setSelected(null)}>
                <ArrowLeft aria-hidden className="size-4" />
                {t.canvas.settings}
              </button>
              <div style={{ viewTransitionName: sheet ? undefined : "fs-detail" }}>{detail(`${ids}-scene-h`)}</div>
            </>
          ) : (
            project
          )}
        </aside>

        <FilmTimeline t={t} scenes={draft.scenes} selected={selected} target={draft.settings.targetSeconds} max={limits.max_film_seconds} onSelect={openScene} />

        <div className="fs-inline-only fs-inspector fs-narrow-project">{project}</div>
        <div className="fs-dock fs-dock-narrow fs-inline-only" role="region" aria-label={t.dock.label}>
          {saveBar}
          {quote(`${ids}-why-n`)}
        </div>
      </div>

      {sheet && sel && (
        <>
          <div className="fs-scrim" onClick={closeSheet} aria-hidden="true" />
          <div className="fs-sheet" role="dialog" aria-modal="true" aria-labelledby={`${ids}-sheet-h`} style={{ viewTransitionName: "fs-scene" }} data-testid="fs-sheet">
            <div className="fs-sheet-handle" aria-hidden="true" />
            <div className="fs-sheet-head">
              <span className="fs-small">{stateText}</span>
              <button type="button" className="fs-icon-key" onClick={closeSheet} aria-label={t.scene.close}>
                <X aria-hidden className="size-5" />
              </button>
            </div>
            {detail(`${ids}-sheet-h`)}
            <div className="fs-sheet-foot">
              <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={closeSheet}>
                {t.scene.close}
              </button>
            </div>
          </div>
        </>
      )}
      {palette && <CommandPalette t={t} commands={commands} onClose={() => setPalette(false)} />}
      {help && <ShortcutsHelp t={t} mod={mod} onClose={() => setHelp(false)} />}
    </div>
  );
}

/** Read-only, archived, conflict and refusal notices, each with its remedy. */
function Notices({
  t,
  view,
  canEdit,
  conflict,
  failure,
  onReload,
}: {
  t: FilmStudioDictionary;
  view: FilmView;
  canEdit: boolean;
  conflict: boolean;
  failure: FilmProject["failure"];
  onReload: () => void;
}) {
  return (
    <>
      {conflict ? (
        <div className="fs-notice" data-tone="fail" role="alert" data-testid="fs-conflict">
          <span className="fs-lamp" data-s="failed" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-2">
            <p className="font-semibold">{t.canvas.conflictTitle}</p>
            <p>{t.canvas.conflictBody}</p>
            <button type="button" className="btn-quiet min-h-11 self-start px-4 text-sm" onClick={onReload}>
              {t.canvas.reload}
            </button>
          </div>
        </div>
      ) : failure ? (
        <FilmErrorNotice t={t} error={failure.error} detail={failure.detail} />
      ) : null}
      {view.film.status === "archived" ? (
        <div className="fs-notice" data-tone="human" data-testid="fs-archived">
          <span className="fs-lamp" data-s="human" aria-hidden="true" />
          <p>{t.canvas.archived}</p>
        </div>
      ) : !view.editable ? (
        <div className="fs-notice" data-tone="human">
          <span className="fs-lamp" data-s="human" aria-hidden="true" />
          <p>{fmt(t.canvas.notEditable, { status: t.status[view.film.status] })}</p>
        </div>
      ) : !canEdit ? (
        <div className="fs-notice" data-tone="human" data-testid="fs-viewer">
          <span className="fs-lamp" data-s="human" aria-hidden="true" />
          <p>{t.canvas.viewer}</p>
        </div>
      ) : null}
    </>
  );
}

const FILM_PLAN_URL = "/api/brain/film";
/** How often a plan another tab is writing (or this one before a refresh) is asked about: its lease ends within 320 s anyway. */
export const AI_WAIT_POLL_MS = 5_000;
/** How long a lost press is confirmed before the panel stops asking and says it cannot reach the server: 0211's lease window. */
export const AI_CONFIRM_MAX_MS = 320_000;
/** A GET that has not answered in this long is given up on (Pixel 11): "could not check", with Check again. */
export const AI_CHECK_TIMEOUT_MS = 20_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A response body as an object, or undefined when it is not JSON (a proxy's 502/504 HTML page, a cut connection). */
async function jsonOf(res: Response): Promise<Record<string, unknown> | undefined> {
  const v: unknown = await res.json().catch(() => undefined);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** GET /api/brain/film, given up on after AI_CHECK_TIMEOUT_MS: a hung request is an answer of its own ("could not check"). */
async function getPlan(filmId: string): Promise<{ res: Response; body: Record<string, unknown> | undefined }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), AI_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`${FILM_PLAN_URL}?film=${encodeURIComponent(filmId)}`, { cache: "no-store", signal: ctl.signal });
    return { res, body: await jsonOf(res) };
  } finally {
    clearTimeout(timer);
  }
}

/** Sign in again and come back to this very project (the app's /login?next=, as LiveView and AssetDownloads do). */
function loginHref(): string {
  const here = typeof window === "undefined" ? "/" : window.location.pathname + window.location.search;
  return `/login?next=${encodeURIComponent(here || "/")}`;
}

/**
 * "Write the storyboard with AI" (Nightshift AI's plan step for this project, app/api/brain/film). The button is on only when the
 * server said, just now, that the plan can run, and it says beforehand what the press uses; otherwise it is off with the reason and
 * its remedy. It never shows a price: the project's own Start quotes.
 *
 * Off without asking the server: a viewer, a project that can no longer be edited, a project that has scenes (saved or not: a
 * person's scenes are never replaced), and unsaved changes (the plan is written for the project as saved). A plan running in
 * another tab, or before a refresh, is followed through its lease until it ends, and the project is read again when it wrote.
 *
 * While it writes, follows another tab's plan, or confirms a press whose answer was lost, `onBusy(true)`: the canvas is read-only
 * then. The project is never reloaded over unsaved changes. A press whose answer was lost is never sent again by itself: the plan's
 * own state is asked, for at most AI_CONFIRM_MAX_MS, then the panel says it cannot reach the server, with Check again.
 *
 * Screen readers (Pixel 1, 2): the button is never `disabled` (it would drop focus on every state change), only aria-disabled, and
 * a press while it is off does nothing; Check again and Reload hand focus back to it. Two live regions exist from the first paint,
 * one `status` (the start, once, and success) and one `alert` (every failure, the server's refusals before a press included); only
 * their text changes. The ticking timer is in neither. A failure is said once, in the alert, never again in the reason under the
 * button.
 */
export function AiWriter({
  t,
  filmId,
  version,
  canEdit,
  readOnly,
  hasScenes,
  dirty,
  reasonId,
  onWritten,
  onBusy,
}: {
  t: FilmStudioDictionary;
  filmId: string;
  version: number;
  canEdit: boolean;
  readOnly: boolean;
  hasScenes: boolean;
  dirty: boolean;
  reasonId: string;
  onWritten: () => Promise<void>;
  onBusy?: (busy: boolean) => void;
}) {
  const w = t.canvas.ai;
  const ids = useId();
  const statusId = `${ids}-status`;
  const alertId = `${ids}-alert`;
  const [check, setCheck] = useState<PlanCheck | { kind: "checking" }>({ kind: "checking" });
  const [writingSince, setWritingSince] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // What the status region says (the start, once; success; confirming) and what the alert region says (one failure at a time).
  const [status, setStatus] = useState("");
  const [failure, setFailure] = useState<Refusal | null>(null);
  // A refusal no new press can change (the project's text, a cap, a region): kept until the project itself changes.
  const [final, setFinal] = useState<{ r: Refusal; version: number } | null>(null);
  // A press whose answer never arrived: the round of asking GET what became of it (0 = not confirming).
  const [confirming, setConfirming] = useState(0);
  const confirmSince = useRef(0);
  // Confirming gave up: the server could not be reached for AI_CONFIRM_MAX_MS. Still busy: what happened is not known.
  const [lost, setLost] = useState(false);
  // The project changed while the plan wrote: the person reloads it when they choose, never by itself.
  const [offerReload, setOfferReload] = useState(false);
  // The empty conversation a press made but could not mark (the 503's retry_session): sent with the next press, kept nowhere else.
  const [retrySession, setRetrySession] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const busy = useRef(false);
  // Only the latest GET sets what the button says: an older answer that arrives late is dropped.
  const seq = useRef(0);
  const dirtyRef = useRef(dirty);
  const hasScenesRef = useRef(hasScenes);
  useEffect(() => {
    dirtyRef.current = dirty;
    hasScenesRef.current = hasScenes;
  }, [dirty, hasScenes]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const local = !canEdit ? w.viewer : readOnly ? w.readOnly : hasScenes ? w.hasScenes : dirty ? w.dirty : null;

  /** The storyboard is in the project: read it again, unless there are unsaved changes on screen, which are never reloaded over. */
  const written = useCallback(
    async (text: string) => {
      setFailure(null);
      if (dirtyRef.current) {
        setStatus(w.writtenKept);
        return;
      }
      setStatus(text);
      await onWritten();
    },
    [onWritten, w],
  );

  /** GET: what the press would do now. `quiet` keeps what is on screen while it asks (the wait for another tab's plan). */
  const runCheck = useCallback(
    async (quiet = false): Promise<Record<string, unknown> | null> => {
      const n = ++seq.current;
      if (!quiet) setCheck({ kind: "checking" });
      try {
        const { res, body } = await getPlan(filmId);
        if (mounted.current && n === seq.current) setCheck(readCheck(w, res.status, body ?? {}));
        return body ?? {};
      } catch (e) {
        // A request given up on (AI_CHECK_TIMEOUT_MS) could not check; one that never left could not reach the server.
        const timedOut = e instanceof DOMException && e.name === "AbortError";
        if (mounted.current && n === seq.current) setCheck({ kind: "blocked", text: timedOut ? w.unavailable : w.network, retry: true });
        return null;
      }
    },
    [filmId, w],
  );

  // Asked whenever a press could be possible: on open, after a press ends, and when the project is empty, saved and editable again.
  useEffect(() => {
    if (local || writingSince !== null || confirming || lost) return;
    void runCheck();
  }, [local, version, writingSince, confirming, lost, runCheck]);

  // Another tab's plan (or this one's before a refresh): asked again until its lease ends; the project is read again when it wrote.
  useEffect(() => {
    if (check.kind !== "running" || writingSince !== null || confirming || lost) return;
    const id = window.setTimeout(async () => {
      const body = await runCheck(true);
      const plan = body?.plan as { state?: unknown } | undefined;
      if (mounted.current && (body?.error === "film_has_scenes" || plan?.state === "done")) {
        // The other tab's plan wrote: success, not a refusal for the alert. Off until the project is read again.
        setCheck({ kind: "checking" });
        await written(w.doneConfirmed);
      }
    }, AI_WAIT_POLL_MS);
    return () => window.clearTimeout(id);
  }, [check, writingSince, confirming, lost, runCheck, written, w]);

  /**
   * One question about a press whose answer was lost. "unreachable": no answer that says anything (offline, the proxy again, a
   * hung GET); "running": the plan is still being written; "settled": the answer is known and has been said.
   */
  const probe = useCallback(async (): Promise<"unreachable" | "running" | "settled"> => {
    let got: { res: Response; body: Record<string, unknown> | undefined } | null = null;
    try {
      got = await getPlan(filmId);
    } catch {
      got = null;
    }
    if (!mounted.current) return "settled";
    const res = got?.res;
    const body = got?.body;
    const plan = body?.plan as { state?: unknown } | undefined;
    if (!res || !body || (res.status >= 500 && typeof body.error !== "string")) return "unreachable";
    if (res.status === 200 && plan?.state === "running") return "running";
    setConfirming(0);
    setLost(false);
    seq.current += 1;
    if (body.error === "film_has_scenes" || plan?.state === "done") {
      // Written: success, not a refusal to put in the alert. Off until the project is read again (it has scenes then).
      setCheck({ kind: "checking" });
      if (!hasScenesRef.current) await written(w.doneConfirmed);
      else setStatus("");
      return "settled";
    }
    // Failed, or ready again (the press never began, or ended without writing): a failure, and Retry is the person's.
    setCheck(readCheck(w, res.status, body));
    const r: Refusal = res.status === 200 ? { text: w.planFailed, retry: true } : refusalText(w, res.status, body);
    setStatus("");
    setFailure(r);
    if (!r.retry) setFinal({ r, version });
    return "settled";
  }, [filmId, version, w, written]);

  // A lost press, asked every AI_WAIT_POLL_MS: running asks again; unreachable asks again until AI_CONFIRM_MAX_MS, then stops.
  useEffect(() => {
    if (!confirming) return;
    const id = window.setTimeout(async () => {
      const got = await probe();
      if (!mounted.current || got === "settled") return;
      if (got === "unreachable" && Date.now() - confirmSince.current >= AI_CONFIRM_MAX_MS) {
        setConfirming(0);
        setLost(true);
        setStatus("");
        setFailure({ text: w.lost, retry: true });
        return;
      }
      setConfirming((n) => n + 1);
    }, AI_WAIT_POLL_MS);
    return () => window.clearTimeout(id);
  }, [confirming, probe, w]);

  useEffect(() => {
    if (writingSince === null) return;
    const id = window.setInterval(() => setElapsed(Math.round((Date.now() - writingSince) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [writingSince]);

  const writing = writingSince !== null;
  const waiting = check.kind === "running";
  const isConfirming = confirming > 0;
  const progress = writing || waiting || isConfirming;
  useEffect(() => {
    onBusy?.(progress || lost);
  }, [onBusy, progress, lost]);
  useEffect(() => () => onBusy?.(false), [onBusy]);

  const finalR = final && final.version === version ? final.r : null;
  // A check's refusal is not said over a reason found here (the project has scenes now, unsaved changes): that one is newer.
  const blockedR: Refusal | null = check.kind === "blocked" && !local ? check : null;
  const ready = check.kind === "ready" ? check.ready : null;
  const enabled = !progress && !lost && !local && !finalR && !blockedR && check.kind !== "checking" && !!ready;

  const press = async () => {
    // Never `disabled` (focus would be lost), so an off button's press is ignored here.
    if (busy.current || !enabled) return;
    busy.current = true;
    setFailure(null);
    setOfferReload(false);
    setElapsed(0);
    // Said once, when it starts: the timer under the button is not announced.
    setStatus(w.writing);
    setWritingSince(Date.now());
    try {
      let res: Response | null = null;
      try {
        res = await fetch(FILM_PLAN_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(retrySession ? { film: filmId, session: retrySession } : { film: filmId }),
        });
      } catch {
        res = null;
      }
      const body = res ? await jsonOf(res) : undefined;
      if (!mounted.current) return;
      // The answer was lost (the connection, or a proxy's own error page): the plan may be running or done. Asked, never re-sent.
      if (!res || !body || (res.status >= 500 && typeof body.error !== "string")) {
        setStatus(w.confirming);
        confirmSince.current = Date.now();
        setConfirming(1);
        return;
      }
      if (typeof body.retry_session === "string" && SESSION_ID.test(body.retry_session)) setRetrySession(body.retry_session);
      else if (res.ok) setRetrySession(null);
      if (res.ok && typeof body.scenes === "number") {
        // A length the server did not send is not drawn as 0:00 (rule 5).
        const text = typeof body.seconds === "number" ? fmt(w.done, { n: body.scenes, length: clock(body.seconds) }) : fmt(w.doneNoLength, { n: body.scenes });
        await written(text);
      } else if (body.error === "plan_running" || body.error === "duplicate_request") {
        setStatus("");
        setCheck({ kind: "running", expiresAt: typeof body.expires_at === "string" ? body.expires_at : null });
      } else if (body.error === "model_unavailable") {
        // The model's state is GET's to say (Pixel 19): the check that follows the press says it, with the button agreeing.
        setStatus("");
      } else {
        const r = refusalText(w, res.status, body, "post");
        setStatus("");
        setFailure(r);
        if (!r.retry) setFinal({ r, version });
        // The project changed while the plan wrote: nothing was saved over it. Reloading is the person's choice (their edits).
        if (body.error === "plan_superseded") setOfferReload(true);
        // Another plan of this project finished first: its scenes are read, unless unsaved changes are on screen.
        if (body.error === "film_has_scenes" && !hasScenesRef.current && !dirtyRef.current) await onWritten();
      }
    } finally {
      busy.current = false;
      if (mounted.current) setWritingSince(null);
    }
  };

  /** Check again: asks GET now (a lost press's plan state, or what a press would do), and hands focus back to the button. */
  const checkAgain = async () => {
    button.current?.focus();
    if (lost) {
      confirmSince.current = Date.now();
      const got = await probe();
      if (mounted.current && got === "running") {
        setLost(false);
        setFailure(null);
        setStatus(w.confirming);
        setConfirming(1);
      }
      return;
    }
    setFinal(null);
    setFailure(null);
    await runCheck();
  };

  // The one failure said now, in the alert region only: the press's, unless it was retryable and the check since says something
  // newer (the model went down meanwhile); else the server's refusal before a press.
  const alertR = failure && !(failure.retry && blockedR) ? failure : finalR ?? blockedR ?? failure;
  const extras = ready ? [costText(w, ready), ...setsText(w, ready), ready.lastFailed && !alertR ? w.lastFailed : ""].filter(Boolean).join(" ") : "";
  // Under the button: why it is off when that is not a failure, what it uses, or the timer. Never a failure's or a status's words.
  const reasonText = writing ? fmt(w.writingFor, { time: clock(elapsed) })
    : isConfirming || lost ? ""
    : waiting ? w.writingElsewhere
    : local ?? (alertR ? "" : check.kind === "checking" ? w.checking : extras);
  // Check again where it can change something: the server could not be reached, a check that failed, or a cap that lifts in time.
  const showCheck = !progress && !local && (lost || (!!alertR && (!!alertR.check || (alertR === blockedR && alertR.retry))));
  const label = failure && failure.retry && enabled ? w.retry : t.canvas.aiWrite;

  return (
    <div className="fs-key-reason" style={{ marginBottom: 14, maxWidth: "none" }} data-testid="fs-ai-panel">
      <button
        ref={button}
        type="button"
        className="btn-quiet min-h-11 self-start px-4 text-sm"
        aria-disabled={!enabled}
        aria-describedby={`${reasonId} ${statusId} ${alertId}`}
        aria-busy={progress || undefined}
        onClick={() => void press()}
        data-testid="fs-ai"
      >
        {label}
      </button>
      <span id={reasonId} className="fs-small" data-testid="fs-ai-reason">
        {reasonText}
      </span>
      {progress && (
        <div className="fs-ai-track" role="progressbar" aria-label={writing ? w.writing : isConfirming ? w.confirming : w.writingElsewhere} data-testid="fs-ai-progress">
          <span className="lp-progress" />
        </div>
      )}
      <p id={statusId} className="fs-small" role="status" data-testid="fs-ai-status">
        {status}
      </p>
      <div id={alertId} role="alert" data-testid="fs-ai-alert">
        {alertR && (
          <div className="fs-notice" data-tone="fail">
            <span className="fs-lamp" data-s="failed" aria-hidden="true" />
            <div className="flex min-w-0 flex-col gap-2">
              <p data-testid="fs-ai-alert-text">{alertR.text}</p>
              {alertR.signIn && (
                <a className="btn-quiet inline-flex min-h-11 items-center self-start px-4 text-sm" href={loginHref()} data-testid="fs-ai-signin">
                  {w.signIn}
                </a>
              )}
            </div>
          </div>
        )}
      </div>
      {showCheck && (
        <button type="button" className="btn-quiet min-h-11 self-start px-4 text-sm" onClick={() => void checkAgain()} data-testid="fs-ai-check">
          {w.checkAgain}
        </button>
      )}
      {offerReload && !dirty && !progress && (
        <button
          type="button"
          className="btn-quiet min-h-11 self-start px-4 text-sm"
          onClick={() => {
            button.current?.focus();
            setOfferReload(false);
            void onWritten();
          }}
          data-testid="fs-ai-reload"
        >
          {w.reload}
        </button>
      )}
    </div>
  );
}
