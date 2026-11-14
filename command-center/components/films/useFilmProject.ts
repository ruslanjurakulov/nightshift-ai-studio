"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  draftProblems,
  filmsApi,
  newSceneDraft,
  refToDraft,
  refsPatch,
  sceneToDraft,
  scenesPatch,
  settingsPatch,
  type FilmError,
  type FilmScene,
  type FilmView,
  type Problem,
  type RefDraft,
  type SceneDraft,
  type SettingsDraft,
} from "@/lib/films";

/**
 * One project's data and state, apart from how it is drawn (the scene grid today; a node canvas may replace it): the saved read model,
 * the draft a person edits, the checks, autosave with its visible state, the version conflict, undo, and archive. Every write goes
 * through /api/films (lib/films filmsApi) as the member; nothing here prices, starts or spends.
 *
 * Autosave. 0166 allows 240 saves a person an hour (and the route 480): a save goes out 4 s after the last edit and never sooner
 * than 20 s after the previous one, so continuous typing makes at most 180 saves an hour and a manual save always has room. A refused
 * save for the rate pauses autosave for 5 minutes; an ended session, a conflict or any other refusal stops it until the person acts.
 */
export const AUTOSAVE_IDLE_MS = 4_000;
export const AUTOSAVE_MIN_GAP_MS = 20_000;
export const AUTOSAVE_BACKOFF_MS = 300_000;
export const UNDO_DEPTH = 50;
/** Typing into one field is one step to undo, not one per keystroke: edits to the same field closer than this are coalesced. */
export const UNDO_COALESCE_MS = 1_500;

export interface Snapshot {
  settings: SettingsDraft;
  scenes: SceneDraft[];
  refs: RefDraft[];
}

export function snapshotOf(view: FilmView): Snapshot {
  return {
    settings: { title: view.film.title, language: view.film.language, aspect: view.film.aspect, targetSeconds: view.film.targetSeconds },
    scenes: view.scenes.map(sceneToDraft),
    refs: view.refs.map(refToDraft),
  };
}

/**
 * What a save would send: only what differs from the saved project. Empty means nothing to save. The comparison runs on the very
 * payloads the database would receive (text cleaned as film_clean_text cleans it), so "unsaved" never disagrees with what a save does.
 */
export function buildPatch(draft: Snapshot, view: FilmView): Record<string, unknown> {
  const saved = snapshotOf(view);
  const savedMap = new Map<string, FilmScene>(view.scenes.map((s) => [s.id, s]));
  const patch: Record<string, unknown> = {};
  const now = settingsPatch(draft.settings);
  const was = settingsPatch(saved.settings);
  for (const k of Object.keys(now)) if (now[k] !== was[k]) patch[k] = now[k];
  const scenes = scenesPatch(draft.scenes, savedMap);
  if (JSON.stringify(scenes) !== JSON.stringify(scenesPatch(saved.scenes, savedMap))) patch.scenes = scenes;
  const refs = refsPatch(draft.refs);
  if (JSON.stringify(refs) !== JSON.stringify(refsPatch(saved.refs))) patch.refs = refs;
  return patch;
}

/** The visible save state: saved, a save on its way, saving, unsaved (a refusal stopped autosave), a fix needed, changed elsewhere. */
export type SaveState = "saved" | "pending" | "saving" | "unsaved" | "fix" | "elsewhere";

export function saveStateOf(s: { conflict: boolean; saving: boolean; dirty: boolean; problems: number; stopped: boolean }): SaveState {
  if (s.conflict) return "elsewhere";
  if (s.saving) return "saving";
  if (!s.dirty) return "saved";
  if (s.problems > 0) return "fix";
  if (s.stopped) return "unsaved";
  return "pending";
}

export type Failure = { error: FilmError; detail?: string };

interface Stacks {
  undo: Snapshot[];
  redo: Snapshot[];
}

function updateStack(
  ref: React.MutableRefObject<Stacks>,
  tick: React.Dispatch<React.SetStateAction<number>>,
  which: keyof Stacks,
  next: Snapshot[] | ((s: Snapshot[]) => Snapshot[]),
) {
  ref.current = { ...ref.current, [which]: typeof next === "function" ? next(ref.current[which]) : next };
  tick((n) => n + 1);
}

/** Narration in two, at the sentence end nearest the middle, else the space nearest it. Empty text splits into two empties. */
export function splitText(text: string): [string, string] {
  const t = text.trim();
  if (!t) return ["", ""];
  const mid = t.length / 2;
  const cuts: number[] = [];
  for (const m of t.matchAll(/[.!?…][)"»]?\s+/g)) cuts.push((m.index ?? 0) + m[0].length);
  if (cuts.length === 0) for (const m of t.matchAll(/\s+/g)) cuts.push((m.index ?? 0) + m[0].length);
  if (cuts.length === 0) return [t, ""];
  const at = cuts.reduce((best, c) => (Math.abs(c - mid) < Math.abs(best - mid) ? c : best), cuts[0]);
  return [t.slice(0, at).trim(), t.slice(at).trim()];
}

const PENDING_PREFIX = "ns.films.pending.";
interface Pending {
  v: 1;
  version: number;
  at: number;
  draft: Snapshot;
}

function isSnapshot(x: unknown): x is Snapshot {
  if (!x || typeof x !== "object") return false;
  const d = x as Record<string, unknown>;
  const st = d.settings as Record<string, unknown> | undefined;
  if (!st || typeof st.title !== "string" || typeof st.language !== "string" || typeof st.aspect !== "string" || typeof st.targetSeconds !== "number") return false;
  if (!Array.isArray(d.refs) || !Array.isArray(d.scenes)) return false;
  return d.scenes.every((s: unknown) => {
    const c = s as Record<string, unknown>;
    return !!c && typeof c.key === "string" && typeof c.title === "string" && typeof c.narration === "string" && typeof c.visualPrompt === "string"
      && typeof c.negativePrompt === "string" && typeof c.plannedSeconds === "number" && typeof c.shotCount === "number"
      && typeof c.firstFrame === "string" && typeof c.lastFrame === "string";
  });
}

/** The buffer for one project, or null (none, unreadable, or storage off): a broken entry is dropped, never half-applied. */
export function readPending(filmId: string): Pending | null {
  try {
    const raw = window.localStorage.getItem(PENDING_PREFIX + filmId);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Pending>;
    if (p.v !== 1 || typeof p.version !== "number" || !isSnapshot(p.draft)) {
      window.localStorage.removeItem(PENDING_PREFIX + filmId);
      return null;
    }
    return p as Pending;
  } catch {
    return null;
  }
}
function writePending(filmId: string, p: Pending) {
  try {
    window.localStorage.setItem(PENDING_PREFIX + filmId, JSON.stringify(p));
  } catch {
    // Storage full or switched off: autosave to the server still runs; the buffer is a second net, not the first.
  }
}
function clearPending(filmId: string) {
  try {
    window.localStorage.removeItem(PENDING_PREFIX + filmId);
  } catch {
    // As above.
  }
}
type Api = ReturnType<typeof filmsApi>;

export function useFilmProject(initial: FilmView, canEdit: boolean, api: Api = filmsApi()) {
  const apiRef = useRef(api);
  const [view, setView] = useState<FilmView>(initial);
  const [draft, setDraftState] = useState<Snapshot>(() => snapshotOf(initial));
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [blockedUntil, setBlockedUntil] = useState(0);
  const [stopped, setStopped] = useState(false);
  // Undo and redo live in a ref, changed synchronously, so two presses before a render never pop the same step twice; the tick
  // re-renders whoever shows "can undo".
  const stacks = useRef<Stacks>({ undo: [], redo: [] });
  const [, setTick] = useState(0);
  const [archiving, setArchiving] = useState(false);
  /** Edits a person left unsaved last time (a refresh, a closed tab): restored at once, or offered when the project moved on since. */
  const [recovered, setRecovered] = useState<"restored" | { stale: Snapshot } | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const draftRef = useRef(draft);
  const lastSaveAt = useRef(0);
  const lastEdit = useRef<{ field: string; at: number } | null>(null);
  const keySeq = useRef(0);
  const savingRef = useRef(false);

  const setDraft = (d: Snapshot) => {
    draftRef.current = d;
    setDraftState(d);
  };

  const readOnly = !canEdit || !view.editable;
  const limits = view.limits;
  const problems: Problem[] = useMemo(() => draftProblems(draft.settings, draft.scenes, draft.refs, limits), [draft, limits]);
  const patch = useMemo(() => buildPatch(draft, view), [draft, view]);
  const dirty = Object.keys(patch).length > 0;
  const saveState = saveStateOf({ conflict, saving, dirty, problems: problems.length, stopped: stopped || failure !== null });

  // ── edits ──────────────────────────────────────────────────────────────────

  /** Every edit goes through here: one undo step per action (typing into one field is coalesced). `field` names the action. */
  const edit = useCallback((field: string, next: (d: Snapshot) => Snapshot, coalesce = true) => {
    const now = Date.now();
    const prev = draftRef.current;
    const same = coalesce && lastEdit.current?.field === field && now - lastEdit.current.at < UNDO_COALESCE_MS;
    if (!same) updateStack(stacks, setTick, "undo", (u) => [...u.slice(-(UNDO_DEPTH - 1)), prev]);
    updateStack(stacks, setTick, "redo", []);
    lastEdit.current = coalesce ? { field, at: now } : null;
    const n = next(prev);
    draftRef.current = n;
    setDraftState(n);
  }, []);

  const changeScene = useCallback(
    (key: string, p: Partial<SceneDraft>, field: string) =>
      edit(`scene:${key}:${field}`, (d) => ({ ...d, scenes: d.scenes.map((s) => (s.key === key ? { ...s, ...p } : s)) })),
    [edit],
  );
  const changeSettings = useCallback(
    (p: Partial<SettingsDraft>, field: string) => edit(`settings:${field}`, (d) => ({ ...d, settings: { ...d.settings, ...p } })),
    [edit],
  );
  const setRefs = useCallback((next: RefDraft[]) => edit("refs", (d) => ({ ...d, refs: next }), false), [edit]);

  const newKey = () => `new-${Date.now().toString(36)}-${(keySeq.current += 1)}`;

  /** A new scene after index `after` (null: at the end). Its key, or null at the limit. */
  const addScene = useCallback(
    (after: number | null): { key: string; index: number } | null => {
      if (draftRef.current.scenes.length >= limits.max_scenes) return null;
      const s = newSceneDraft(newKey(), limits);
      const at = after === null ? draftRef.current.scenes.length : after + 1;
      edit("structure", (d) => ({ ...d, scenes: [...d.scenes.slice(0, at), s, ...d.scenes.slice(at)] }), false);
      return { key: s.key, index: at };
    },
    [edit, limits],
  );

  /** A copy of a scene right after it: a new scene (no id, no takes). */
  const duplicate = useCallback(
    (key: string): { key: string; index: number } | null => {
      const d0 = draftRef.current;
      const i = d0.scenes.findIndex((s) => s.key === key);
      if (i < 0 || d0.scenes.length >= limits.max_scenes) return null;
      const copy: SceneDraft = { ...d0.scenes[i], key: newKey(), id: null, status: "draft", hasTakes: false };
      edit("structure", (d) => ({ ...d, scenes: [...d.scenes.slice(0, i + 1), copy, ...d.scenes.slice(i + 1)] }), false);
      return { key: copy.key, index: i + 1 };
    },
    [edit, limits],
  );

  /** Delete a scene (never one with takes: 0166 refuses it). The neighbour that takes its place, for the selection. */
  const remove = useCallback(
    (key: string): { index: number; next: string | null } | null => {
      const d0 = draftRef.current;
      const i = d0.scenes.findIndex((s) => s.key === key);
      if (i < 0 || d0.scenes[i].hasTakes) return null;
      const rest = d0.scenes.filter((s) => s.key !== key);
      edit("structure", (d) => ({ ...d, scenes: d.scenes.filter((s) => s.key !== key) }), false);
      return { index: i, next: rest[Math.min(i, rest.length - 1)]?.key ?? null };
    },
    [edit],
  );

  /** Move a scene to index `to`. The first scene has nothing before it: one that continued from it starts from its own key frame. */
  const moveTo = useCallback(
    (key: string, to: number): { from: number; to: number } | null => {
      const d0 = draftRef.current;
      const from = d0.scenes.findIndex((s) => s.key === key);
      if (from < 0 || to < 0 || to >= d0.scenes.length || to === from) return null;
      edit(
        "structure",
        (d) => {
          const list = [...d.scenes];
          const [item] = list.splice(from, 1);
          list.splice(to, 0, item);
          if (list[0].firstFrame === "previous") list[0] = { ...list[0], firstFrame: "keyframe" };
          return { ...d, scenes: list };
        },
        false,
      );
      return { from, to };
    },
    [edit],
  );

  /** Put back the draft as it was before the last edit. Null when there is nothing to undo. */
  const undo = useCallback((): Snapshot | null => {
    const u = stacks.current.undo;
    if (u.length === 0) return null;
    const prev = u[u.length - 1];
    updateStack(stacks, setTick, "undo", u.slice(0, -1));
    const cur = draftRef.current;
    updateStack(stacks, setTick, "redo", (r) => [...r.slice(-(UNDO_DEPTH - 1)), cur]);
    lastEdit.current = null;
    draftRef.current = prev;
    setDraftState(prev);
    return prev;
  }, []);

  /** Put back what the last undo took away. Null when there is nothing to redo (any new edit clears it). */
  const redo = useCallback((): Snapshot | null => {
    const r = stacks.current.redo;
    if (r.length === 0) return null;
    const next = r[r.length - 1];
    updateStack(stacks, setTick, "redo", r.slice(0, -1));
    const cur = draftRef.current;
    updateStack(stacks, setTick, "undo", (u) => [...u.slice(-(UNDO_DEPTH - 1)), cur]);
    lastEdit.current = null;
    draftRef.current = next;
    setDraftState(next);
    return next;
  }, []);

  /**
   * Split a scene in two: the narration at the sentence (or else the word) boundary nearest its middle, the planned length in two
   * halves inside the limits, the second part continuing from the first's last frame. Free: it is an edit of the draft (rule 3).
   */
  const split = useCallback(
    (key: string): { key: string; index: number } | { refused: "too_short" | "full" } | null => {
      const d0 = draftRef.current;
      const i = d0.scenes.findIndex((s) => s.key === key);
      if (i < 0) return null;
      const a = d0.scenes[i];
      if (d0.scenes.length >= limits.max_scenes) return { refused: "full" };
      if (a.plannedSeconds < limits.scene_seconds_min * 2) return { refused: "too_short" };
      const [n1, n2] = splitText(a.narration);
      const s1 = Math.ceil(a.plannedSeconds / 2);
      const first: SceneDraft = { ...a, narration: n1, plannedSeconds: s1, lastFrame: "none", lastFrameAssetId: null, lastFrameMissing: false };
      const second: SceneDraft = {
        ...a,
        key: newKey(),
        id: null,
        status: "draft",
        hasTakes: false,
        narration: n2,
        plannedSeconds: a.plannedSeconds - s1,
        firstFrame: "previous",
        firstFrameAssetId: null,
        firstFrameMissing: false,
      };
      edit("structure", (d) => ({ ...d, scenes: [...d.scenes.slice(0, i), first, second, ...d.scenes.slice(i + 1)] }), false);
      return { key: second.key, index: i };
    },
    [edit, limits],
  );

  /**
   * Merge a scene with the next one: their narration and prompts joined, their lengths added (refused past the scene limit, never
   * cut), the merged scene ending as the second one ended. A next scene that already has takes cannot go (0166 refuses it).
   */
  const merge = useCallback(
    (key: string): { key: string; index: number } | { refused: "last" | "too_long" | "takes" } | null => {
      const d0 = draftRef.current;
      const i = d0.scenes.findIndex((s) => s.key === key);
      if (i < 0) return null;
      const a = d0.scenes[i];
      const b = d0.scenes[i + 1];
      if (!b) return { refused: "last" };
      if (b.hasTakes) return { refused: "takes" };
      if (a.plannedSeconds + b.plannedSeconds > limits.scene_seconds_max) return { refused: "too_long" };
      const join = (x: string, y: string, sep: string) => (x.trim() && y.trim() && x.trim() !== y.trim() ? `${x.trim()}${sep}${y.trim()}` : x.trim() || y.trim());
      const merged: SceneDraft = {
        ...a,
        title: a.title.trim() || b.title,
        narration: join(a.narration, b.narration, "\n"),
        visualPrompt: join(a.visualPrompt, b.visualPrompt, "\n"),
        negativePrompt: join(a.negativePrompt, b.negativePrompt, ", "),
        plannedSeconds: a.plannedSeconds + b.plannedSeconds,
        shotCount: Math.min(limits.max_shots, Math.max(a.shotCount, b.shotCount)),
        lastFrame: b.lastFrame,
        lastFrameAssetId: b.lastFrameAssetId,
        lastFrameMissing: b.lastFrameMissing,
      };
      edit("structure", (d) => ({ ...d, scenes: [...d.scenes.slice(0, i), merged, ...d.scenes.slice(i + 2)] }), false);
      return { key: merged.key, index: i };
    },
    [edit, limits],
  );

  // ── saving ─────────────────────────────────────────────────────────────────

  /** A fresh read model and the draft rebuilt from it (after a conflict, or when the project stopped being editable). */
  const reload = useCallback(async (): Promise<Snapshot | null> => {
    const r = await apiRef.current.get(view.film.id);
    if (!r.ok) {
      setFailure({ error: r.error, detail: r.detail });
      return null;
    }
    const snap = snapshotOf(r.data);
    setView(r.data);
    draftRef.current = snap;
    setDraftState(snap);
    updateStack(stacks, setTick, "undo", []);
    updateStack(stacks, setTick, "redo", []);
    setConflict(false);
    setFailure(null);
    setStopped(false);
    return snap;
  }, [view.film.id]);

  const save = useCallback(
    async (): Promise<"saved" | "nothing" | "fix" | "refused" | "busy"> => {
      if (savingRef.current) return "busy";
      if (readOnly || conflict) return "refused";
      const sent = draftRef.current;
      const body = buildPatch(sent, view);
      if (Object.keys(body).length === 0) return "nothing";
      if (draftProblems(sent.settings, sent.scenes, sent.refs, limits).length > 0) return "fix";
      savingRef.current = true;
      setSaving(true);
      lastSaveAt.current = Date.now();
      const r = await apiRef.current.save(view.film.id, view.film.version, body);
      savingRef.current = false;
      setSaving(false);
      if (r.ok) {
        const fresh = r.data;
        setView(fresh);
        setFailure(null);
        setStopped(false);
        // New scenes got their ids: give them to the draft by their position in what was sent, keeping the screen's own keys, so an
        // edit made while the save was in flight is kept and saved next.
        const idOf = new Map<string, string>();
        sent.scenes.forEach((s, i) => {
          if (!s.id && fresh.scenes[i]) idOf.set(s.key, fresh.scenes[i].id);
        });
        const savedOf = new Map(fresh.scenes.map((s) => [s.id, s]));
        const unchanged = draftRef.current === sent;
        const rebase = (d: Snapshot): Snapshot => ({
          ...d,
          scenes: d.scenes.map((s) => {
            const id = s.id ?? idOf.get(s.key) ?? null;
            const row = id ? savedOf.get(id) : undefined;
            return { ...s, id, status: row?.status ?? s.status, hasTakes: row ? row.takes.length > 0 : s.hasTakes };
          }),
          refs: unchanged && d === sent ? fresh.refs.map(refToDraft) : d.refs,
        });
        const next = rebase(draftRef.current);
        draftRef.current = next;
        setDraftState(next);
        updateStack(stacks, setTick, "undo", (u) => u.map(rebase));
        updateStack(stacks, setTick, "redo", (u) => u.map(rebase));
        return "saved";
      }
      setFailure({ error: r.error, detail: r.detail });
      if (r.error === "film_changed") setConflict(true);
      else if (r.error === "rate_limited" || r.error === "rate_limit_unavailable") setBlockedUntil(Date.now() + AUTOSAVE_BACKOFF_MS);
      else if (r.error === "film_not_editable") void reload();
      else setStopped(true);
      return "refused";
    },
    [readOnly, conflict, view, limits, reload],
  );

  // Autosave: after the person stops, never too often, never while a fix is needed or after a refusal that needs a person.
  useEffect(() => {
    if (!dirty || readOnly || conflict || saving || stopped || problems.length > 0) return;
    if (failure && failure.error !== "rate_limited" && failure.error !== "rate_limit_unavailable") return;
    const now = Date.now();
    const at = Math.max(now + AUTOSAVE_IDLE_MS, lastSaveAt.current + AUTOSAVE_MIN_GAP_MS, blockedUntil);
    const timer = window.setTimeout(() => void save(), at - now);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, readOnly, conflict, saving, stopped, failure, problems.length, blockedUntil, save]);

  // The pending-edit buffer: what is not saved yet is kept in this browser, per project, with the version it was made on. A refresh
  // or a closed tab loses nothing: the next load puts it back when the project has not moved on, and otherwise offers it, never
  // applying it over someone else's newer save without the person saying so.
  useEffect(() => {
    // The buffer is written only after it was read, so the first render's clean draft never erases what a refresh left behind.
    setHydrated(true);
    if (readOnly) return;
    const pending = readPending(view.film.id);
    if (!pending) return;
    if (pending.version === view.film.version) {
      const server = draftRef.current;
      updateStack(stacks, setTick, "undo", (u) => [...u, server]);
      draftRef.current = pending.draft;
      setDraftState(pending.draft);
      setRecovered("restored");
    } else {
      setRecovered({ stale: pending.draft });
    }
    // Once, on load: a later change of version is this screen's own save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated || readOnly || (recovered && recovered !== "restored")) return;
    if (dirty) writePending(view.film.id, { v: 1, version: view.film.version, at: Date.now(), draft });
    else clearPending(view.film.id);
  }, [hydrated, draft, dirty, readOnly, recovered, view.film.id, view.film.version]);

  /** Apply edits left from an older version: the person's explicit choice, and the next save replaces the newer version. */
  const applyStale = useCallback(() => {
    if (!recovered || recovered === "restored") return;
    edit("recovered", () => recovered.stale, false);
    setRecovered("restored");
  }, [recovered, edit]);
  const discardRecovered = useCallback(() => {
    clearPending(view.film.id);
    setRecovered(null);
  }, [view.film.id]);

  const archive = useCallback(async (): Promise<boolean> => {
    setArchiving(true);
    const r = await apiRef.current.archive(view.film.id);
    setArchiving(false);
    if (!r.ok) {
      setFailure({ error: r.error, detail: r.detail });
      if (r.error === "film_not_editable") void reload();
      return false;
    }
    setView(r.data);
    clearPending(view.film.id);
    setDraft(snapshotOf(r.data));
    updateStack(stacks, setTick, "undo", []);
    updateStack(stacks, setTick, "redo", []);
    setFailure(null);
    return true;
  }, [view.film.id, reload]);

  return {
    view,
    draft,
    limits,
    readOnly,
    problems,
    dirty,
    saving,
    saveState,
    conflict,
    failure,
    archiving,
    canUndo: stacks.current.undo.length > 0,
    canRedo: stacks.current.redo.length > 0,
    recovered,
    applyStale,
    discardRecovered,
    redo,
    split,
    merge,
    edit,
    changeScene,
    changeSettings,
    setRefs,
    addScene,
    duplicate,
    remove,
    moveTo,
    undo,
    save,
    reload,
    archive,
    dismissFailure: () => setFailure(null),
  };
}

export type FilmProject = ReturnType<typeof useFilmProject>;
