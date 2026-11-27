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
import { costText, readCheck, refusalText, type PlanCheck } from "@/lib/brain/film-plan-view";

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
  const ro = readOnly && t.palette.readOnly;
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

  const lamp = saveState === "saved" ? "ready" : saveState === "saving" ? "work" : saveState === "elsewhere" ? "failed" : saveState === "fix" || saveState === "unsaved" ? "warn" : undefined;
  const stateText = projectReadOnly ? t.canvas.readOnlyState : t.canvas.saveState[saveState];
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
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A response body as an object, or undefined when it is not JSON (a proxy's 502/504 HTML page, a cut connection). */
async function jsonOf(res: Response): Promise<Record<string, unknown> | undefined> {
  const v: unknown = await res.json().catch(() => undefined);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * "Write the storyboard with AI" (Nightshift AI's plan step for this project, app/api/brain/film). The button is on only when the
 * server said, just now, that the plan can run, and it says beforehand what the press uses ("about N of the M messages left
 * today"); otherwise it is off with the reason and its remedy. It never shows a price: the project's own Start quotes.
 *
 * Off without asking the server: a viewer, a project that can no longer be edited, a project that has scenes (saved or not: a
 * person's scenes are never replaced), and unsaved changes (the plan is written for the project as saved). A plan running in
 * another tab, or before a refresh, is followed through its lease until it ends, and the project is read again when it wrote.
 *
 * While it writes, follows another tab's plan, or confirms a press whose answer was lost, `onBusy(true)`: the canvas is read-only
 * then (an edit made meanwhile would be superseded, or would supersede the plan). The project is never reloaded over unsaved
 * changes: "written, your changes are kept", and the save's own conflict path takes it from there. A press whose answer was lost
 * (a network error, a proxy's 502/504) is never sent again by itself: the plan's own state is asked until it says what happened.
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
  const [check, setCheck] = useState<PlanCheck | { kind: "checking" }>({ kind: "checking" });
  const [writingSince, setWritingSince] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState<{ tone: "ok" | "fail"; text: string } | null>(null);
  // A refusal no new press can change (the project's text, a cap, a region): kept until the project itself changes.
  const [final, setFinal] = useState<{ text: string; version: number } | null>(null);
  // A press whose answer never arrived: the round of asking GET what became of it (0 = not confirming).
  const [confirming, setConfirming] = useState(0);
  // The project changed while the plan wrote: the person reloads it when they choose, never by itself.
  const [offerReload, setOfferReload] = useState(false);
  // The empty conversation a press made but could not mark (the 503's retry_session): sent with the next press, kept nowhere else.
  const [retrySession, setRetrySession] = useState<string | null>(null);
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
      if (dirtyRef.current) {
        setNotice({ tone: "ok", text: w.writtenKept });
        return;
      }
      setNotice({ tone: "ok", text });
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
        const res = await fetch(`${FILM_PLAN_URL}?film=${encodeURIComponent(filmId)}`, { cache: "no-store" });
        const body = (await jsonOf(res)) ?? {};
        if (mounted.current && n === seq.current) setCheck(readCheck(w, res.status, body));
        return body;
      } catch {
        if (mounted.current && n === seq.current) setCheck({ kind: "blocked", text: w.network, retry: true });
        return null;
      }
    },
    [filmId, w],
  );

  // Asked whenever a press could be possible: on open, after a press ends, and when the project is empty, saved and editable again.
  useEffect(() => {
    if (local || writingSince !== null || confirming) return;
    void runCheck();
  }, [local, version, writingSince, confirming, runCheck]);

  // Another tab's plan (or this one's before a refresh): asked again until its lease ends; the project is read again when it wrote.
  useEffect(() => {
    if (check.kind !== "running" || writingSince !== null || confirming) return;
    const id = window.setTimeout(async () => {
      const body = await runCheck(true);
      const plan = body?.plan as { state?: unknown } | undefined;
      if (mounted.current && (body?.error === "film_has_scenes" || plan?.state === "done")) await written(w.doneConfirmed);
    }, AI_WAIT_POLL_MS);
    return () => window.clearTimeout(id);
  }, [check, writingSince, confirming, runCheck, written, w]);

  // A press whose answer was lost: the plan's state, asked every AI_WAIT_POLL_MS, says what happened. Running: ask again. Written
  // (the project has scenes now, or the lease is done): read the project. Anything else: the press did not write, said with Retry.
  useEffect(() => {
    if (!confirming) return;
    const id = window.setTimeout(async () => {
      let res: Response | null = null;
      let body: Record<string, unknown> | undefined;
      try {
        res = await fetch(`${FILM_PLAN_URL}?film=${encodeURIComponent(filmId)}`, { cache: "no-store" });
        body = await jsonOf(res);
      } catch {
        res = null;
      }
      if (!mounted.current) return;
      const plan = body?.plan as { state?: unknown } | undefined;
      // Still no answer that says anything (offline, the proxy again), or the plan is still running: asked again.
      if (!res || !body || (res.status >= 500 && typeof body.error !== "string") || (res.status === 200 && plan?.state === "running")) {
        setConfirming((n) => n + 1);
        return;
      }
      setConfirming(0);
      seq.current += 1;
      setCheck(readCheck(w, res.status, body));
      if (body.error === "film_has_scenes" || plan?.state === "done") {
        if (!hasScenesRef.current) await written(w.doneConfirmed);
        return;
      }
      // Failed, or ready again (the press never began, or ended without writing): a failure, and Retry is the person's.
      const r = res.status === 200 ? { text: w.planFailed, retry: true } : refusalText(w, res.status, body);
      setNotice({ tone: "fail", text: r.text });
      if (!r.retry) setFinal({ text: r.text, version });
    }, AI_WAIT_POLL_MS);
    return () => window.clearTimeout(id);
  }, [confirming, filmId, version, w, written]);

  useEffect(() => {
    if (writingSince === null) return;
    const id = window.setInterval(() => setElapsed(Math.round((Date.now() - writingSince) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [writingSince]);

  const press = async () => {
    if (busy.current) return;
    busy.current = true;
    setNotice(null);
    setOfferReload(false);
    setElapsed(0);
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
        setNotice({ tone: "ok", text: w.confirming });
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
        setCheck({ kind: "running", expiresAt: typeof body.expires_at === "string" ? body.expires_at : null });
      } else {
        const r = refusalText(w, res.status, body);
        setNotice({ tone: "fail", text: r.text });
        if (!r.retry) setFinal({ text: r.text, version });
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

  const writing = writingSince !== null;
  const waiting = check.kind === "running";
  const isConfirming = confirming > 0;
  useEffect(() => {
    onBusy?.(writing || waiting || isConfirming);
  }, [onBusy, writing, waiting, isConfirming]);
  useEffect(() => () => onBusy?.(false), [onBusy]);

  const finalText = final && final.version === version ? final.text : null;
  const blocked = local ?? finalText ?? (check.kind === "blocked" ? check.text : check.kind === "checking" ? w.checking : null);
  const ready = check.kind === "ready" ? check.ready : null;
  const enabled = !writing && !waiting && !isConfirming && !blocked && !!ready;
  const extras = ready
    ? [
        costText(w, ready),
        ready.sets.clip ? fmt(w.setsClip, { name: ready.sets.clip }) : "",
        ready.sets.keyframe ? fmt(w.setsKeyframe, { name: ready.sets.keyframe }) : "",
        ready.lastFailed && !notice ? w.lastFailed : "",
      ].filter(Boolean).join(" ")
    : "";
  const progress = writing || waiting || isConfirming;

  return (
    <div className="fs-key-reason" style={{ marginBottom: 14, maxWidth: "none" }} data-testid="fs-ai-panel">
      <button
        type="button"
        className="btn-quiet min-h-11 self-start px-4 text-sm"
        disabled={!enabled}
        aria-describedby={reasonId}
        aria-busy={progress || undefined}
        onClick={() => void press()}
        data-testid="fs-ai"
      >
        {notice?.tone === "fail" && enabled ? w.retry : t.canvas.aiWrite}
      </button>
      <span id={reasonId} className="fs-small" data-testid="fs-ai-reason">
        {writing ? `${w.writing} ${fmt(w.writingFor, { time: clock(elapsed) })}` : isConfirming ? w.confirming : waiting ? w.writingElsewhere : (blocked ?? extras)}
      </span>
      {progress && <progress className="w-full max-w-xs" aria-label={writing ? w.writing : isConfirming ? w.confirming : w.writingElsewhere} data-testid="fs-ai-progress" />}
      {!progress && !local && !finalText && check.kind === "blocked" && check.retry && (
        <button type="button" className="btn-quiet min-h-11 self-start px-4 text-sm" onClick={() => void runCheck()} data-testid="fs-ai-check">
          {w.checkAgain}
        </button>
      )}
      <p className="fs-small" role={notice?.tone === "fail" ? "alert" : "status"} data-testid="fs-ai-notice">
        {notice?.text ?? ""}
      </p>
      {offerReload && !dirty && !progress && (
        <button
          type="button"
          className="btn-quiet min-h-11 self-start px-4 text-sm"
          onClick={() => {
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
