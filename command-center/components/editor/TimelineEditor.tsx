"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Pause,
  Play,
  Plus,
  Redo2,
  Scissors,
  Music,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { Chip } from "@/components/ui/Chip";
import { Timecode } from "@/components/ui/Timecode";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import {
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  GAIN_UI_MAX,
  GAIN_UI_MIN,
  MAX_AUDIO_CLIPS,
  MAX_EDITOR_CLIPS,
  MAX_EDITOR_SOUNDS,
  MAX_EDITOR_TEXTS,
  MAX_TEXT,
  SOUND_FADE_MAX_S,
  DUCK_ATTACK_MAX_S,
  DUCK_ATTACK_MIN_S,
  DUCK_DB_MAX,
  DUCK_DEFAULT,
  DUCK_RELEASE_MAX_S,
  DUCK_RELEASE_MIN_S,
  DUCK_UI_MAX_DB,
  DUCK_UI_MIN_DB,
  XFADE_DEFAULT_S,
  XFADE_MIN_S,
  SPEEDS,
  TEXT_COLOR,
  TEXT_OUTLINE_COLOR,
  TEXT_POSITIONS,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  addClip,
  addSound,
  addText,
  audioInputs,
  canAddSound,
  canSplit,
  clamp,
  clipAt,
  crossfadeOf,
  exportActive,
  fitSoundToPicture,
  formatTime,
  layout,
  maxCrossfade,
  modelDuration,
  moveClip,
  positionOf,
  removeClip,
  removeSound,
  removeText,
  setClipAudio,
  setCrossfade,
  setSpeed,
  soundLength,
  soundWarnings,
  speechSpans,
  splitClip,
  textWarnings,
  textsAt,
  toDoc,
  toModel,
  trimClip,
  updateSound,
  updateText,
  validateTimeline,
  type EditorAsset,
  type EditorError,
  type EditorExport,
  type EditorModel,
  type SoundClip,
  type TextClip,
  type TextPosition,
  type TimelineDoc,
} from "@/lib/editor";
import {
  deleteProject,
  fetchProject,
  requestExport,
  saveProject,
} from "./editorApi";
import { TimelineStrip, pictureEnd, type Selection } from "./TimelineStrip";
import { SoundPreview } from "./SoundPreview";

const HISTORY = 100;
const POLL_MS = 4000;

const fieldClass =
  "rounded-[var(--ns-r-key)] w-full border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-[16px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[13px]";
const quietBtn =
  "btn-quiet inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px]";

/** Keys inside these keep their own meaning. */
function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function textBoxStyle(x: TextClip, width: number): CSSProperties {
  const ty =
    x.anchor === "top" || x.anchor === "top-left" || x.anchor === "top-right"
      ? "0"
      : x.anchor.startsWith("bottom")
        ? "-100%"
        : "-50%";
  return {
    left: `${x.x * 100}%`,
    top: `${x.y * 100}%`,
    transform: `translate(-50%, ${ty})`,
    // Output pixels → a share of the frame's width, so the preview scales like the export.
    fontSize: `${(x.size / width) * 100}cqw`,
    fontWeight: x.bold === false ? 400 : 700,
    color: x.color ?? TEXT_COLOR,
    textShadow: `0 0 2px ${TEXT_OUTLINE_COLOR}, 0 0 2px ${TEXT_OUTLINE_COLOR}, 0 0 3px ${TEXT_OUTLINE_COLOR}`,
  };
}

/**
 * The editor: a preview, the timeline, and the free tools — trim (handles or
 * numbers), split at the playhead, speed 0.5–2×, the clip's own sound, a
 * cross-fade from the clip before, music and sound effects from the library
 * (where, which part, how loud, fades), and text on the picture (what, when,
 * how big, where). Every change is a new
 * document in memory with undo; Save stores it (the route and the database
 * check it); Export asks the media worker to render the SAVED version. No
 * button here renders, spends or publishes by itself: an export is a request
 * row, free, and ends as a file in the library.
 */
export function TimelineEditor({
  projectId,
  title: initialTitle,
  rev: initialRev,
  doc,
  exports: initialExports,
  assets: initialAssets,
  videos,
  soundFiles = [],
}: {
  projectId: string;
  title: string;
  rev: number;
  doc: TimelineDoc;
  exports: EditorExport[];
  assets: Record<string, EditorAsset>;
  videos: readonly EditorAsset[];
  /** The library's audio files, for music and sound effects. */
  soundFiles?: readonly EditorAsset[];
}) {
  const { t, locale } = useI18n();
  const te = t.editor;
  const path = useChannelPath();
  const router = useRouter();
  const ids = useId();

  const [model, setModel] = useState<EditorModel>(() => toModel(doc));
  const [past, setPast] = useState<EditorModel[]>([]);
  const [future, setFuture] = useState<EditorModel[]>([]);
  const [saved, setSaved] = useState(() => JSON.stringify(toDoc(toModel(doc))));
  const [title, setTitle] = useState(initialTitle);
  const [savedTitle, setSavedTitle] = useState(initialTitle);
  const [rev, setRev] = useState(initialRev);
  const [selected, setSelected] = useState<Selection>(() => {
    const first = toModel(doc).clips[0];
    return first ? { kind: "clip", id: first.id } : null;
  });
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<EditorError | "text_empty" | null>(null);
  const [exports, setExports] = useState(initialExports);
  const [assets, setAssets] = useState(initialAssets);
  const [adding, setAdding] = useState(false);
  const [addingSound, setAddingSound] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dragBase = useRef<EditorModel | null>(null);

  const clips = useMemo(() => layout(model.clips), [model.clips]);
  const total = useMemo(() => modelDuration(model), [model]);
  const picture = pictureEnd(clips);
  const current = useMemo(() => JSON.stringify(toDoc(model)), [model]);
  const dirty = current !== saved || title.trim() !== savedTitle;
  const active = exportActive(exports);
  const warnings = textWarnings(model);
  const soundWarns = soundWarnings(model);
  const speech = useMemo(() => speechSpans(model), [model]);

  // ── history ────────────────────────────────────────────────────────────────
  const apply = useCallback(
    (next: EditorModel) => {
      if (next === model) return;
      setPast((p) => [...p.slice(-(HISTORY - 1)), model]);
      setFuture([]);
      setModel(next);
      setError(null);
    },
    [model],
  );
  const undo = useCallback(() => {
    if (!past.length) return;
    setFuture([model, ...future]);
    setModel(past[past.length - 1]);
    setPast(past.slice(0, -1));
  }, [model, past, future]);
  const redo = useCallback(() => {
    if (!future.length) return;
    setPast([...past, model]);
    setModel(future[0]);
    setFuture(future.slice(1));
  }, [model, past, future]);

  // A selection whose clip or text is gone (undo, delete) is no selection.
  useEffect(() => {
    if (
      selected?.kind === "clip" &&
      !model.clips.some((c) => c.id === selected.id)
    )
      setSelected(
        model.clips[0] ? { kind: "clip", id: model.clips[0].id } : null,
      );
    if (
      selected?.kind === "text" &&
      !model.texts.some((x) => x.id === selected.id)
    )
      setSelected(null);
    if (
      selected?.kind === "sound" &&
      !model.sounds.some((x) => x.id === selected.id)
    )
      setSelected(null);
  }, [model, selected]);

  useEffect(() => {
    if (playhead > total) setPlayhead(total);
  }, [playhead, total]);

  // ── preview ────────────────────────────────────────────────────────────────
  const video = useRef<HTMLVideoElement>(null);
  const at = clipAt(model, Math.min(playhead, Math.max(0, picture - 0.001)));
  const src = at ? (assets[at.clip.asset_id]?.viewUrl ?? null) : null;
  // A picture sent from the Library or Studio is a still: it is drawn, not played.
  const still = at ? assets[at.clip.asset_id]?.kind === "image" : false;
  const shownClip = useRef<string | null>(null);
  const refreshed = useRef(false);

  useEffect(() => {
    const v = video.current;
    if (!v || !at) return;
    v.playbackRate = at.clip.speed;
    v.muted = !at.clip.audio;
    const switched = shownClip.current !== at.clip.id;
    shownClip.current = at.clip.id;
    if (!playing || switched) {
      if (Math.abs((v.currentTime || 0) - at.sourceS) > 0.05) {
        try {
          v.currentTime = at.sourceS;
        } catch {
          /* not loaded yet: loadedmetadata seeks */
        }
      }
      if (playing && switched)
        void v.play?.()?.catch?.(() => setPlaying(false));
    }
  }, [at, playing, src]);

  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;

  useEffect(() => {
    if (!playing) {
      video.current?.pause?.();
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const ph = playheadRef.current;
      const v = video.current;
      const here = clipAt(model, Math.min(ph, Math.max(0, picture - 0.001)));
      let next: number;
      if (!here) {
        // Past the picture (text only), or nothing to play: the clock runs.
        next = ph + dt;
      } else {
        const c = here.clip;
        const end = c.start_s + (c.out_s - c.in_s) / c.speed;
        const viaVideo = Boolean(v && src && !v.paused && v.readyState >= 2);
        const t =
          viaVideo && v
            ? c.start_s + (v.currentTime - c.in_s) / c.speed
            : ph + dt;
        // At a clip's end the playhead jumps to the next clip's start.
        next = t >= end - 0.01 ? end : clamp(t, c.start_s, end);
      }
      if (next >= total - 0.001) {
        playheadRef.current = total;
        setPlayhead(total);
        setPlaying(false);
        return;
      }
      playheadRef.current = next;
      setPlayhead(next);
      raf = requestAnimationFrame(tick);
    };
    void video.current?.play?.()?.catch?.(() => {});
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, model, picture, total, src]);

  const togglePlay = () => {
    if (!playing && playhead >= total - 0.001) setPlayhead(0);
    setPlaying((p) => !p);
  };

  async function refreshLinks() {
    const out = await fetchProject(projectId);
    if (out.ok) {
      setAssets((a) => ({ ...a, ...out.value.assets }));
      setExports(out.value.exports);
    }
  }

  // ── exports: poll while one is on its way ─────────────────────────────────
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(async () => {
      const out = await fetchProject(projectId);
      if (out.ok) {
        setExports(out.value.exports);
        setAssets((a) => ({ ...a, ...out.value.assets }));
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, projectId]);

  // ── keyboard: undo / redo / save / play ───────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
        return;
      }
      if (typing(e.target)) return;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // ── save / export / delete ────────────────────────────────────────────────
  async function save() {
    if (saving || !dirty) return;
    const docNow = toDoc(model);
    if (Object.values(warnings).includes("empty")) {
      setError("text_empty");
      return;
    }
    if (validateTimeline(docNow).length) {
      setError("invalid_doc");
      return;
    }
    setSaving(true);
    setError(null);
    const out = await saveProject(
      projectId,
      rev,
      title.trim() !== savedTitle ? title : null,
      docNow,
    );
    setSaving(false);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    setRev(out.value.rev);
    setSaved(JSON.stringify(docNow));
    setSavedTitle(title.trim());
  }

  async function startExport() {
    if (dirty || active || starting) return;
    setStarting(true);
    setError(null);
    const out = await requestExport(projectId, rev);
    setStarting(false);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    setExports((e) => [
      {
        id: out.value.id,
        rev,
        status: "queued",
        reason: null,
        durationS: total,
        assetId: null,
        createdAt: new Date().toISOString(),
        finishedAt: null,
      },
      ...e,
    ]);
  }

  async function onDelete() {
    const out = await deleteProject(projectId);
    if (!out.ok) {
      setConfirmDelete(false);
      setError(out.error);
      return;
    }
    router.push(path("/editor"));
  }

  // ── tools ─────────────────────────────────────────────────────────────────
  const clip =
    selected?.kind === "clip"
      ? (clips.find((c) => c.id === selected.id) ?? null)
      : null;
  const clipIndex = clip ? clips.findIndex((c) => c.id === clip.id) : -1;
  const text =
    selected?.kind === "text"
      ? (model.texts.find((x) => x.id === selected.id) ?? null)
      : null;
  const sound =
    selected?.kind === "sound"
      ? (model.sounds.find((x) => x.id === selected.id) ?? null)
      : null;
  const srcLen = (c: { asset_id: string }) =>
    assets[c.asset_id]?.durationS ?? null;

  function onTrim(
    id: string,
    edge: "in" | "out",
    value: number,
    commit: boolean,
  ) {
    const c = model.clips.find((x) => x.id === id);
    if (!c) return;
    if (!commit) {
      // While dragging: change what is shown, keep one history step for the whole drag.
      if (!dragBase.current) dragBase.current = model;
      setModel(trimClip(model, id, edge, value, srcLen(c)));
      return;
    }
    apply(trimClip(model, id, edge, value, srcLen(c)));
  }

  function onTrimEnd() {
    const base = dragBase.current;
    dragBase.current = null;
    if (base && base !== model) {
      setPast((p) => [...p.slice(-(HISTORY - 1)), base]);
      setFuture([]);
    }
  }

  function onSplit() {
    if (!clip) return;
    const out = splitClip(model, clip.id, playhead);
    if (out) apply(out.model);
  }

  function onAddText() {
    const out = addText(model, playhead < picture ? playhead : 0, te.newText);
    if (!out) return;
    apply(out.model);
    setSelected({ kind: "text", id: out.id });
  }

  function onAddVideo(a: EditorAsset) {
    const next = addClip(model, a);
    if (next === model) return;
    setAssets((x) => ({ ...x, [a.id]: a }));
    apply(next);
    setSelected({ kind: "clip", id: next.clips[next.clips.length - 1].id });
    setAdding(false);
  }

  function onAddSound(a: EditorAsset) {
    const out = addSound(model, a, playhead < picture ? playhead : 0);
    if (!out) return;
    setAssets((x) => ({ ...x, [a.id]: a }));
    apply(out.model);
    setSelected({ kind: "sound", id: out.id });
    setAddingSound(false);
  }

  const audioFull = audioInputs(model) >= MAX_AUDIO_CLIPS;
  const shownTexts = textsAt(model, playhead);
  const errorText =
    error === "text_empty" ? te.textEmpty : error ? te.errors[error] : null;
  const exportBlocked = dirty
    ? te.exportNeedsSave
    : active
      ? te.exportBusy
      : null;
  const when = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
  };

  return (
    <div className="flex flex-col gap-4">
      {/* header: name, history, save, export */}
      <div className="panel flex flex-col gap-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={path("/editor")}
            className="text-[13px] text-[var(--color-primary)] underline-offset-4 hover:underline"
          >
            ← {te.back}
          </Link>
          <span
            className="ml-auto text-[12px] text-[var(--color-muted)]"
            aria-live="polite"
          >
            {saving ? te.saving : dirty ? te.unsaved : te.saved}
          </span>
        </div>
        <label className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
          {te.projectTitle}
          <input
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            className={fieldClass}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={undo}
            disabled={!past.length}
            className={quietBtn}
          >
            <Undo2 className="size-3.5" aria-hidden />
            {te.undo}
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={!future.length}
            className={quietBtn}
          >
            <Redo2 className="size-3.5" aria-hidden />
            {te.redo}
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="btn-quiet text-[13px]"
          >
            {saving ? te.saving : te.save}
          </button>
          <button
            type="button"
            onClick={() => void startExport()}
            disabled={Boolean(exportBlocked) || starting}
            aria-describedby={exportBlocked ? `${ids}-export-why` : undefined}
            className="btn-primary text-[13px]"
          >
            {starting ? te.exporting : te.export}
          </button>
        </div>
        {exportBlocked ? (
          <p
            id={`${ids}-export-why`}
            className="m-0 text-[12px] text-[var(--color-muted)]"
          >
            {exportBlocked}
          </p>
        ) : null}
        <p className="m-0 text-[12px] text-[var(--color-muted)]">
          {te.freeNote} {te.publishNote}
        </p>
        {errorText ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--color-fail)]"
          >
            <span>{errorText}</span>
            {error === "stale_revision" ? (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className={quietBtn}
              >
                {te.reload}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-3">
          {/* preview */}
          <div
            className="relative mx-auto w-full overflow-hidden rounded-[var(--ns-r-panel)] border border-[var(--color-border)] bg-black"
            style={{
              aspectRatio: `${model.width} / ${model.height}`,
              maxHeight: "60vh",
              maxWidth: `calc(60vh * ${model.width / model.height})`,
              containerType: "inline-size",
            }}
          >
            {src && still ? (
              // eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived library link
              <img
                src={src}
                alt=""
                className="size-full object-contain"
                onError={() => {
                  if (!refreshed.current) {
                    refreshed.current = true;
                    void refreshLinks();
                  }
                }}
              />
            ) : src ? (
              <video
                ref={video}
                src={src}
                playsInline
                preload="auto"
                className="size-full object-contain"
                onLoadedMetadata={() => {
                  const v = video.current;
                  if (v && at) {
                    v.currentTime = at.sourceS;
                    v.playbackRate = at.clip.speed;
                    if (playing)
                      void v.play?.()?.catch?.(() => setPlaying(false));
                  }
                }}
                onError={() => {
                  // A ten-minute link expired: ask once for fresh ones.
                  if (!refreshed.current) {
                    refreshed.current = true;
                    void refreshLinks();
                  }
                }}
              />
            ) : (
              <p className="absolute inset-0 m-0 flex items-center justify-center p-4 text-center text-[12px] text-[var(--color-muted)]">
                {te.noPreview}
              </p>
            )}
            {shownTexts.map((x) => (
              <span
                key={x.id}
                className="pointer-events-none absolute whitespace-pre-wrap text-center leading-tight"
                style={textBoxStyle(x, model.width)}
              >
                {x.text}
              </span>
            ))}
          </div>
          <p className="m-0 text-center text-[11px] text-[var(--color-muted)]">
            {te.previewNote}
            {model.sounds.length ? ` ${te.soundPreviewNote}` : ""}
          </p>
          <SoundPreview
            sounds={model.sounds}
            assets={assets}
            playhead={playhead}
            playing={playing}
            speech={speech}
          />

          {/* transport */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={togglePlay}
              aria-label={playing ? te.pause : te.play}
              className="btn-primary inline-flex size-11 items-center justify-center p-0"
            >
              {playing ? (
                <Pause className="size-4" aria-hidden />
              ) : (
                <Play className="size-4" aria-hidden />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(total, 0.001)}
              step={1 / model.fps}
              value={Math.min(playhead, total)}
              onChange={(e) => {
                setPlaying(false);
                setPlayhead(Number(e.target.value));
              }}
              aria-label={te.playhead}
              aria-valuetext={fmt(te.timeOf, {
                now: formatTime(playhead),
                total: formatTime(total),
              })}
              className="min-w-0 flex-1 accent-[var(--color-primary)]"
            />
            {/* The master-control readout: frame-accurate timecode at the project's rate; the spoken form keeps tenths. */}
            <span className="shrink-0 text-[12px] text-[var(--color-muted)]">
              <Timecode value={playhead} format="frames" fps={model.fps} label={formatTime(playhead)} /> /{" "}
              <Timecode value={total} format="frames" fps={model.fps} label={formatTime(total)} />
            </span>
          </div>

          <TimelineStrip
            clips={clips}
            texts={model.texts}
            sounds={model.sounds}
            total={total}
            fps={model.fps}
            playhead={playhead}
            selected={selected}
            assets={assets}
            onSelect={setSelected}
            onTrim={onTrim}
            onTrimEnd={onTrimEnd}
          />

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setAdding((a) => !a)}
              aria-expanded={adding}
              disabled={model.clips.length >= MAX_EDITOR_CLIPS}
              className={quietBtn}
            >
              <Plus className="size-3.5" aria-hidden />
              {te.addVideo}
            </button>
            <button
              type="button"
              onClick={() => setAddingSound((a) => !a)}
              aria-expanded={addingSound}
              disabled={!canAddSound(model)}
              className={quietBtn}
            >
              <Music className="size-3.5" aria-hidden />
              {te.addSound}
            </button>
            <button
              type="button"
              onClick={onAddText}
              disabled={model.texts.length >= MAX_EDITOR_TEXTS}
              className={quietBtn}
            >
              <Type className="size-3.5" aria-hidden />
              {te.addText}
            </button>
          </div>
          {model.sounds.length >= MAX_EDITOR_SOUNDS ? (
            <p className="m-0 text-[12px] text-[var(--color-muted)]">
              {fmt(te.maxSounds, { max: MAX_EDITOR_SOUNDS })}
            </p>
          ) : audioFull ? (
            <p className="m-0 text-[12px] text-[var(--color-muted)]">
              {fmt(te.audioFull, { max: MAX_AUDIO_CLIPS })}
            </p>
          ) : null}
          {addingSound ? (
            <section
              aria-label={te.addSoundTitle}
              className="panel flex flex-col gap-2 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="m-0 text-[13px] font-semibold">
                  {te.addSoundTitle}
                </h3>
                <button
                  type="button"
                  onClick={() => setAddingSound(false)}
                  className={quietBtn}
                >
                  {te.close}
                </button>
              </div>
              {soundFiles.length === 0 ? (
                <p className="m-0 text-[12px] text-[var(--color-muted)]">
                  {te.noSounds}{" "}
                  <Link
                    href={path("/library")}
                    className="text-[var(--color-primary)] underline-offset-4 hover:underline"
                  >
                    {te.openLibrary}
                  </Link>
                </p>
              ) : (
                <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2">
                  {soundFiles.map((a) => (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => onAddSound(a)}
                        className="flex w-full min-w-0 items-center justify-between gap-2 rounded-[var(--ns-r-key)] border border-[var(--color-border)] p-2 text-left text-[12px]"
                      >
                        <span className="truncate text-[var(--color-fg)]">
                          {a.name ?? te.untitledSound}
                        </span>
                        <span className="shrink-0 text-[var(--color-muted)]">
                          <Timecode value={a.durationS} format="duration" />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
          {model.clips.length >= MAX_EDITOR_CLIPS ? (
            <p className="m-0 text-[12px] text-[var(--color-muted)]">
              {fmt(te.maxClips, { max: MAX_EDITOR_CLIPS })}
            </p>
          ) : null}
          {model.texts.length >= MAX_EDITOR_TEXTS ? (
            <p className="m-0 text-[12px] text-[var(--color-muted)]">
              {fmt(te.maxTexts, { max: MAX_EDITOR_TEXTS })}
            </p>
          ) : null}
          {adding ? (
            <section
              aria-label={te.addVideoTitle}
              className="panel flex flex-col gap-2 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="m-0 text-[13px] font-semibold">
                  {te.addVideoTitle}
                </h3>
                <button
                  type="button"
                  onClick={() => setAdding(false)}
                  className={quietBtn}
                >
                  {te.close}
                </button>
              </div>
              {videos.length === 0 ? (
                <p className="m-0 text-[12px] text-[var(--color-muted)]">
                  {te.noVideos}
                </p>
              ) : (
                <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3">
                  {videos.map((v) => (
                    <li key={v.id}>
                      <button
                        type="button"
                        onClick={() => onAddVideo(v)}
                        className="flex w-full min-w-0 flex-col gap-1 rounded-[var(--ns-r-key)] border border-[var(--color-border)] p-2 text-left text-[12px]"
                      >
                        <span className="truncate text-[var(--color-fg)]">
                          {v.name ?? te.untitledVideo}
                        </span>
                        <span className="text-[var(--color-muted)]">
                          <Timecode value={v.durationS} format="duration" />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </div>

        {/* inspector */}
        <aside
          className="panel flex min-w-0 flex-col gap-3 p-4"
          aria-label={
            clip
              ? te.trim
              : text
                ? te.textLabel
                : sound
                  ? te.soundHeading
                  : te.timeline
          }
        >
          {sound ? (
            <SoundInspector
              key={sound.id}
              sound={sound}
              name={assets[sound.asset_id]?.name ?? te.untitledSound}
              sourceS={srcLen(sound)}
              warning={soundWarns[sound.id] ?? null}
              hasSpeech={speech.length > 0}
              onChange={(patch) =>
                apply(updateSound(model, sound.id, patch, srcLen(sound)))
              }
              onToPlayhead={() =>
                apply(
                  updateSound(
                    model,
                    sound.id,
                    { start_s: playhead },
                    srcLen(sound),
                  ),
                )
              }
              onFit={() => apply(fitSoundToPicture(model, sound.id))}
              onDelete={() => apply(removeSound(model, sound.id))}
            />
          ) : clip ? (
            <ClipInspector
              key={clip.id}
              n={clipIndex + 1}
              clip={clip}
              sourceS={srcLen(clip)}
              canSplitHere={canSplit(model, clip.id, playhead)}
              onlyClip={model.clips.length <= 1}
              first={clipIndex === 0}
              last={clipIndex === clips.length - 1}
              onIn={(v) =>
                apply(trimClip(model, clip.id, "in", v, srcLen(clip)))
              }
              onOut={(v) =>
                apply(trimClip(model, clip.id, "out", v, srcLen(clip)))
              }
              onSpeed={(s) => apply(setSpeed(model, clip.id, s))}
              onAudio={(a) => apply(setClipAudio(model, clip.id, a))}
              audioLocked={!clip.audio && audioFull}
              crossfade={crossfadeOf(clip)}
              maxCrossfade={maxCrossfade(model, clip.id)}
              onCrossfade={(d) => apply(setCrossfade(model, clip.id, d))}
              onSplit={onSplit}
              onMove={(by) => apply(moveClip(model, clip.id, by))}
              onDelete={() => apply(removeClip(model, clip.id))}
            />
          ) : text ? (
            <TextInspector
              key={text.id}
              text={text}
              warning={warnings[text.id] ?? null}
              onChange={(patch) => apply(updateText(model, text.id, patch))}
              onDelete={() => apply(removeText(model, text.id))}
            />
          ) : (
            <p className="m-0 text-[13px] text-[var(--color-muted)]">
              {te.selectHint}
            </p>
          )}
        </aside>
      </div>

      {/* exports */}
      <section
        aria-labelledby={`${ids}-exports`}
        className="panel flex flex-col gap-2 p-4"
      >
        <h2 id={`${ids}-exports`} className="m-0 text-[15px] font-semibold">
          {te.exports}
        </h2>
        {exports.length === 0 ? (
          <p className="m-0 text-[13px] text-[var(--color-muted)]">
            {te.noExports}
          </p>
        ) : (
          <ul
            className="m-0 flex list-none flex-col gap-2 p-0"
            aria-live="polite"
          >
            {exports.map((x) => {
              const out = x.assetId ? assets[x.assetId] : undefined;
              const tone =
                x.status === "done"
                  ? "text-[var(--color-ok)]"
                  : x.status === "failed"
                    ? "text-[var(--color-fail)]"
                    : "text-[var(--color-warn)]";
              return (
                <li
                  key={x.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-border)] pt-2 text-[13px] first:border-t-0 first:pt-0"
                >
                  <span className={`font-semibold ${tone}`}>
                    {te.exportStatus[x.status]}
                  </span>
                  <span className="text-[12px] text-[var(--color-muted)]">
                    {fmt(te.exportRev, { rev: x.rev })}
                    {x.durationS ? (
                      <>
                        {" · "}
                        <Timecode value={x.durationS} format="duration" />
                      </>
                    ) : null}
                    {x.createdAt ? ` · ${when(x.createdAt)}` : ""}
                  </span>
                  {x.status === "failed" ? (
                    <span className="w-full text-[12px] text-[var(--color-fail)]">
                      {te.exportReasons[x.reason ?? "other"]}
                    </span>
                  ) : null}
                  {x.status === "done" ? (
                    <span className="flex flex-wrap gap-3">
                      {out?.viewUrl ? (
                        <a
                          href={out.viewUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[var(--color-primary)] underline-offset-4 hover:underline"
                        >
                          {te.watch}
                        </a>
                      ) : null}
                      <Link
                        href={path("/library")}
                        className="text-[var(--color-primary)] underline-offset-4 hover:underline"
                      >
                        {te.viewInLibrary}
                      </Link>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-2">
        {confirmDelete ? (
          <div
            role="group"
            aria-label={te.deleteProject}
            className="panel flex flex-wrap items-center gap-2 p-3 text-[13px]"
          >
            <span>{te.deleteConfirm}</span>
            <button
              type="button"
              onClick={() => void onDelete()}
              className="btn-primary text-[12px]"
            >
              {te.deleteYes}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className={quietBtn}
            >
              {te.cancel}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className={`${quietBtn} text-[var(--color-fail)]`}
          >
            <Trash2 className="size-3.5" aria-hidden />
            {te.deleteProject}
          </button>
        )}
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  step: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const v = Number(draft.replace(",", "."));
    if (Number.isFinite(v) && v !== value) onCommit(v);
    else setDraft(String(value));
  };
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[12px] text-[var(--color-muted)]">
      {label}
      <input
        type="number"
        inputMode="decimal"
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        className={fieldClass}
      />
    </label>
  );
}

function ClipInspector({
  n,
  clip,
  sourceS,
  canSplitHere,
  onlyClip,
  first,
  last,
  onIn,
  onOut,
  onSpeed,
  onAudio,
  audioLocked,
  crossfade,
  maxCrossfade: maxX,
  onCrossfade,
  onSplit,
  onMove,
  onDelete,
}: {
  n: number;
  clip: {
    id: string;
    in_s: number;
    out_s: number;
    speed: number;
    audio: boolean;
  };
  sourceS: number | null;
  canSplitHere: boolean;
  onlyClip: boolean;
  first: boolean;
  last: boolean;
  onIn: (v: number) => void;
  onOut: (v: number) => void;
  onSpeed: (s: number) => void;
  onAudio: (a: boolean) => void;
  audioLocked: boolean;
  /** The cross-fade into this clip in seconds (0 = a cut). */
  crossfade: number;
  /** The longest it can be (0 = this clip cannot have one). */
  maxCrossfade: number;
  onCrossfade: (seconds: number) => void;
  onSplit: () => void;
  onMove: (by: -1 | 1) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const te = t.editor;
  const id = useId();
  return (
    <>
      <h2 className="m-0 text-[14px] font-semibold">
        {fmt(te.clipHeading, { n })}
      </h2>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label={te.trimIn}
          value={clip.in_s}
          min={0}
          max={clip.out_s}
          step={0.1}
          onCommit={onIn}
        />
        <NumberField
          label={te.trimOut}
          value={clip.out_s}
          min={clip.in_s}
          max={sourceS ?? undefined}
          step={0.1}
          onCommit={onOut}
        />
      </div>
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1 p-0 text-[12px] text-[var(--color-muted)]">
          {te.speed}
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {SPEEDS.map((s) => (
            <label
              key={s}
              className="ns-chip"
              data-radio=""
              data-on={clip.speed === s ? "true" : undefined}
            >
              <input
                type="radio"
                name={`${id}-speed`}
                value={s}
                checked={clip.speed === s}
                onChange={() => onSpeed(s)}
                className="sr-only"
              />
              {fmt(te.speedValue, { x: s })}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={clip.audio}
          disabled={audioLocked}
          onChange={(e) => onAudio(e.target.checked)}
          className="size-4 accent-[var(--color-primary)]"
        />
        {te.sound}
      </label>
      <fieldset
        className="m-0 flex flex-col gap-1.5 border-0 p-0"
        aria-describedby={`${id}-xf`}
      >
        <legend className="mb-1 p-0 text-[12px] text-[var(--color-muted)]">
          {te.transition}
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {(["cut", "crossfade"] as const).map((kind) => {
            const on = kind === "cut" ? crossfade <= 0 : crossfade > 0;
            const disabled = kind === "crossfade" && !maxX && crossfade <= 0;
            return (
              <label
                key={kind}
                className="ns-chip"
                data-radio=""
                data-on={on ? "true" : undefined}
                data-disabled={disabled ? "true" : undefined}
              >
                <input
                  type="radio"
                  name={`${id}-xf`}
                  value={kind}
                  checked={on}
                  disabled={disabled}
                  onChange={() =>
                    onCrossfade(
                      kind === "cut" ? 0 : Math.min(XFADE_DEFAULT_S, maxX),
                    )
                  }
                  className="sr-only"
                />
                {kind === "cut" ? te.cut : te.crossfade}
              </label>
            );
          })}
        </div>
        {crossfade > 0 && maxX ? (
          <NumberField
            label={te.crossfadeLength}
            value={crossfade}
            min={XFADE_MIN_S}
            max={maxX}
            step={0.1}
            onCommit={onCrossfade}
          />
        ) : null}
        <p id={`${id}-xf`} className="m-0 text-[11px] text-[var(--color-muted)]">
          {first
            ? te.crossfadeFirst
            : !maxX && crossfade <= 0
              ? fmt(te.crossfadeTooShort, { min: XFADE_MIN_S })
              : te.crossfadeHint}
        </p>
      </fieldset>
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={onSplit}
          disabled={!canSplitHere}
          aria-describedby={canSplitHere ? undefined : `${id}-split`}
          className={`${quietBtn} self-start`}
        >
          <Scissors className="size-3.5" aria-hidden />
          {te.split}
        </button>
        {!canSplitHere ? (
          <p
            id={`${id}-split`}
            className="m-0 text-[11px] text-[var(--color-muted)]"
          >
            {te.splitHint}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={first}
          className={quietBtn}
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          {te.moveEarlier}
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={last}
          className={quietBtn}
        >
          <ArrowRight className="size-3.5" aria-hidden />
          {te.moveLater}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={onlyClip}
          className={`${quietBtn} text-[var(--color-fail)]`}
        >
          <Trash2 className="size-3.5" aria-hidden />
          {te.deleteClip}
        </button>
      </div>
      {onlyClip ? (
        <p className="m-0 text-[11px] text-[var(--color-muted)]">
          {te.lastClip}
        </p>
      ) : null}
    </>
  );
}

function TextInspector({
  text,
  warning,
  onChange,
  onDelete,
}: {
  text: TextClip;
  warning: "empty" | "past_end" | null;
  onChange: (patch: Partial<Omit<TextClip, "id">>) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const te = t.editor;
  const id = useId();
  const [draft, setDraft] = useState(text.text);
  useEffect(() => setDraft(text.text), [text.text]);
  const pos = positionOf(text);
  return (
    <>
      <h2 className="m-0 text-[14px] font-semibold">{te.textLabel}</h2>
      <div className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
        <label className="flex flex-col gap-1">
          {te.textLabel}
          <textarea
            value={draft}
            maxLength={MAX_TEXT}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => draft !== text.text && onChange({ text: draft })}
            aria-describedby={`${id}-count`}
            className="rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-[16px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[13px]"
          />
        </label>
        <span id={`${id}-count`} className="text-[11px]">
          {fmt(te.textCount, { n: draft.length, max: MAX_TEXT })}
        </span>
      </div>
      {warning ? (
        <p role="status" className="m-0 text-[12px] text-[var(--color-warn)]">
          {warning === "empty" ? te.textEmpty : te.textPastEnd}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label={te.textStart}
          value={text.start_s}
          min={0}
          step={0.1}
          onCommit={(v) =>
            onChange({ start_s: v, end_s: Math.max(text.end_s, v + 0.1) })
          }
        />
        <NumberField
          label={te.textEnd}
          value={text.end_s}
          min={text.start_s}
          step={0.1}
          onCommit={(v) => onChange({ end_s: v })}
        />
      </div>
      <label className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
        {te.textSize} · {text.size}
        <input
          type="range"
          min={TEXT_SIZE_MIN}
          max={TEXT_SIZE_MAX}
          step={2}
          value={text.size}
          onChange={(e) => onChange({ size: Number(e.target.value) })}
          className="accent-[var(--color-primary)]"
        />
      </label>
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1 p-0 text-[12px] text-[var(--color-muted)]">
          {te.textPosition}
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(TEXT_POSITIONS) as TextPosition[]).map((p) => (
            <label
              key={p}
              className="ns-chip"
              data-radio=""
              data-on={pos === p ? "true" : undefined}
            >
              <input
                type="radio"
                name={`${id}-pos`}
                value={p}
                checked={pos === p}
                onChange={() => onChange({ ...TEXT_POSITIONS[p] })}
                className="sr-only"
              />
              {te.positions[p]}
            </label>
          ))}
        </div>
      </fieldset>
      <button
        type="button"
        onClick={onDelete}
        className={`${quietBtn} self-start text-[var(--color-fail)]`}
      >
        <Trash2 className="size-3.5" aria-hidden />
        {te.deleteText}
      </button>
    </>
  );
}

function SoundInspector({
  sound,
  name,
  sourceS,
  warning,
  hasSpeech,
  onChange,
  onToPlayhead,
  onFit,
  onDelete,
}: {
  sound: SoundClip;
  name: string;
  sourceS: number | null;
  warning: "past_end" | null;
  /** Whether anything on the timeline is speech (what a duck lowers under). */
  hasSpeech: boolean;
  onChange: (patch: Partial<Omit<SoundClip, "id" | "asset_id">>) => void;
  onToPlayhead: () => void;
  onFit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const te = t.editor;
  const id = useId();
  const len = soundLength(sound);
  const fadeMax = Math.min(SOUND_FADE_MAX_S, len);
  return (
    <>
      <h2 className="m-0 text-[14px] font-semibold">{te.soundHeading}</h2>
      <p className="m-0 truncate text-[12px] text-[var(--color-muted)]">
        {name} · <Timecode value={len} format="duration" label={formatTime(len)} />
      </p>
      {warning ? (
        <div role="status" className="flex flex-col gap-1.5">
          <p className="m-0 text-[12px] text-[var(--color-warn)]">
            {te.soundPastEnd}
          </p>
          <button
            type="button"
            onClick={onFit}
            className={`${quietBtn} self-start`}
          >
            {te.soundFit}
          </button>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label={te.soundStart}
          value={sound.start_s}
          min={0}
          step={0.1}
          onCommit={(v) => onChange({ start_s: v })}
        />
        <div className="flex items-end">
          <button
            type="button"
            onClick={onToPlayhead}
            className={`${quietBtn} w-full justify-center`}
          >
            {te.soundToPlayhead}
          </button>
        </div>
        <NumberField
          label={te.soundIn}
          value={sound.in_s}
          min={0}
          max={sound.out_s}
          step={0.1}
          onCommit={(v) => onChange({ in_s: v })}
        />
        <NumberField
          label={te.soundOut}
          value={sound.out_s}
          min={sound.in_s}
          max={sourceS ?? undefined}
          step={0.1}
          onCommit={(v) => onChange({ out_s: v })}
        />
      </div>
      <label className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
        <span id={`${id}-vol`}>
          {te.soundVolume} · {fmt(te.soundVolumeValue, { db: sound.gain_db })}
        </span>
        <input
          type="range"
          min={Math.min(GAIN_UI_MIN, sound.gain_db)}
          max={Math.max(GAIN_UI_MAX, sound.gain_db)}
          step={1}
          value={sound.gain_db}
          aria-valuetext={fmt(te.soundVolumeValue, { db: sound.gain_db })}
          onChange={(e) =>
            onChange({
              gain_db: Math.min(
                GAIN_DB_MAX,
                Math.max(GAIN_DB_MIN, Number(e.target.value)),
              ),
            })
          }
          className="accent-[var(--color-primary)]"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label={te.soundFadeIn}
          value={sound.fade_in_s}
          min={0}
          max={fadeMax}
          step={0.1}
          onCommit={(v) => onChange({ fade_in_s: v })}
        />
        <NumberField
          label={te.soundFadeOut}
          value={sound.fade_out_s}
          min={0}
          max={fadeMax}
          step={0.1}
          onCommit={(v) => onChange({ fade_out_s: v })}
        />
      </div>
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1 p-0 text-[12px] text-[var(--color-muted)]">
          {te.soundKind}
        </legend>
        <div className="flex gap-1.5">
          {(["music", "speech"] as const).map((r) => {
            const on = (sound.role ?? "music") === r;
            return (
              <Chip
                key={r}
                pressed={on}
                onClick={() => {
                  if (!on) onChange({ role: r });
                }}
              >
                {r === "music" ? te.roleMusic : te.roleSpeech}
              </Chip>
            );
          })}
        </div>
        <p className="m-0 text-[11px] text-[var(--color-muted)]">
          {sound.role === "speech" ? te.roleSpeechHint : te.roleMusicHint}
        </p>
      </fieldset>
      {sound.role !== "speech" ? (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={Boolean(sound.duck)}
              onChange={(e) =>
                onChange({ duck: e.target.checked ? DUCK_DEFAULT : undefined })
              }
              className="accent-[var(--color-primary)]"
            />
            {te.duckToggle}
          </label>
          {sound.duck ? (
            <>
              <label className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
                <span>
                  {te.duckAmount} ·{" "}
                  {fmt(te.soundVolumeValue, { db: -sound.duck.amount_db })}
                </span>
                <input
                  type="range"
                  min={Math.min(DUCK_UI_MIN_DB, sound.duck.amount_db)}
                  max={Math.max(DUCK_UI_MAX_DB, sound.duck.amount_db)}
                  step={1}
                  value={sound.duck.amount_db}
                  aria-valuetext={fmt(te.soundVolumeValue, {
                    db: -sound.duck.amount_db,
                  })}
                  onChange={(e) =>
                    onChange({
                      duck: {
                        ...(sound.duck ?? DUCK_DEFAULT),
                        amount_db: Math.min(
                          DUCK_DB_MAX,
                          Number(e.target.value),
                        ),
                      },
                    })
                  }
                  className="accent-[var(--color-primary)]"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label={te.duckAttack}
                  value={sound.duck.attack_s}
                  min={DUCK_ATTACK_MIN_S}
                  max={DUCK_ATTACK_MAX_S}
                  step={0.05}
                  onCommit={(v) =>
                    onChange({
                      duck: {
                        ...(sound.duck ?? DUCK_DEFAULT),
                        attack_s: v,
                      },
                    })
                  }
                />
                <NumberField
                  label={te.duckRelease}
                  value={sound.duck.release_s}
                  min={DUCK_RELEASE_MIN_S}
                  max={DUCK_RELEASE_MAX_S}
                  step={0.1}
                  onCommit={(v) =>
                    onChange({
                      duck: {
                        ...(sound.duck ?? DUCK_DEFAULT),
                        release_s: v,
                      },
                    })
                  }
                />
              </div>
              <p
                role={hasSpeech ? undefined : "status"}
                className={`m-0 text-[11px] ${hasSpeech ? "text-[var(--color-muted)]" : "text-[var(--color-warn)]"}`}
              >
                {hasSpeech ? te.duckHint : te.duckNoSpeech}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        onClick={onDelete}
        className={`${quietBtn} self-start text-[var(--color-fail)]`}
      >
        <Trash2 className="size-3.5" aria-hidden />
        {te.deleteSound}
      </button>
    </>
  );
}
