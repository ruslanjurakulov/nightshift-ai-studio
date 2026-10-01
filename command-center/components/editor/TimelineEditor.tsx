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
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import {
  MAX_EDITOR_CLIPS,
  MAX_EDITOR_TEXTS,
  MAX_TEXT,
  SPEEDS,
  TEXT_COLOR,
  TEXT_OUTLINE_COLOR,
  TEXT_POSITIONS,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  addClip,
  addText,
  canSplit,
  clamp,
  clipAt,
  exportActive,
  formatTime,
  layout,
  modelDuration,
  moveClip,
  positionOf,
  removeClip,
  removeText,
  setClipAudio,
  setSpeed,
  splitClip,
  textWarnings,
  textsAt,
  toDoc,
  toModel,
  trimClip,
  updateText,
  validateTimeline,
  type EditorAsset,
  type EditorError,
  type EditorExport,
  type EditorModel,
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

const HISTORY = 100;
const POLL_MS = 4000;

const fieldClass =
  "pill w-full border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-[16px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[13px]";
const quietBtn =
  "btn-sky is-quiet pill inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px]";

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
 * numbers), split at the playhead, speed 0.5–2×, the clip's own sound, and
 * text on the picture (what, when, how big, where). Every change is a new
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
}: {
  projectId: string;
  title: string;
  rev: number;
  doc: TimelineDoc;
  exports: EditorExport[];
  assets: Record<string, EditorAsset>;
  videos: readonly EditorAsset[];
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dragBase = useRef<EditorModel | null>(null);

  const clips = useMemo(() => layout(model.clips), [model.clips]);
  const total = useMemo(() => modelDuration(model), [model]);
  const picture = pictureEnd(clips);
  const current = useMemo(() => JSON.stringify(toDoc(model)), [model]);
  const dirty = current !== saved || title.trim() !== savedTitle;
  const active = exportActive(exports);
  const warnings = textWarnings(model);

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
  }, [model, selected]);

  useEffect(() => {
    if (playhead > total) setPlayhead(total);
  }, [playhead, total]);

  // ── preview ────────────────────────────────────────────────────────────────
  const video = useRef<HTMLVideoElement>(null);
  const at = clipAt(model, Math.min(playhead, Math.max(0, picture - 0.001)));
  const src = at ? (assets[at.clip.asset_id]?.viewUrl ?? null) : null;
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
            className="btn-sky ghost pill px-4 py-2 text-[13px]"
          >
            {saving ? te.saving : te.save}
          </button>
          <button
            type="button"
            onClick={() => void startExport()}
            disabled={Boolean(exportBlocked) || starting}
            aria-describedby={exportBlocked ? `${ids}-export-why` : undefined}
            className="btn-sky is-solid pill px-4 py-2 text-[13px]"
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
            className="relative mx-auto w-full overflow-hidden rounded-2xl border border-[var(--color-border)] bg-black"
            style={{
              aspectRatio: `${model.width} / ${model.height}`,
              maxHeight: "60vh",
              maxWidth: `calc(60vh * ${model.width / model.height})`,
              containerType: "inline-size",
            }}
          >
            {src ? (
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
          </p>

          {/* transport */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={togglePlay}
              aria-label={playing ? te.pause : te.play}
              className="btn-sky is-solid pill inline-flex size-10 items-center justify-center p-0"
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
            <span className="shrink-0 text-[12px] tabular-nums text-[var(--color-muted)]">
              {formatTime(playhead)} / {formatTime(total)}
            </span>
          </div>

          <TimelineStrip
            clips={clips}
            texts={model.texts}
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
              onClick={onAddText}
              disabled={model.texts.length >= MAX_EDITOR_TEXTS}
              className={quietBtn}
            >
              <Type className="size-3.5" aria-hidden />
              {te.addText}
            </button>
          </div>
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
                        className="flex w-full min-w-0 flex-col gap-1 rounded-xl border border-[var(--color-border)] p-2 text-left text-[12px]"
                      >
                        <span className="truncate text-[var(--color-fg)]">
                          {v.name ?? te.untitledVideo}
                        </span>
                        <span className="text-[var(--color-muted)]">
                          {formatTime(v.durationS ?? 0)}
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
          aria-label={clip ? te.trim : text ? te.textLabel : te.timeline}
        >
          {clip ? (
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
                    {x.durationS ? ` · ${formatTime(x.durationS)}` : ""}
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
              className="btn-sky is-solid pill px-3 py-1.5 text-[12px]"
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
              className={`cursor-pointer rounded-full border px-2.5 py-1 text-[12px] focus-within:ring-2 focus-within:ring-[var(--color-primary)] ${
                clip.speed === s
                  ? "border-[var(--color-primary)] bg-[var(--color-accent-soft)] text-[var(--color-fg)]"
                  : "border-[var(--color-border)] text-[var(--color-muted)]"
              }`}
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
          onChange={(e) => onAudio(e.target.checked)}
          className="size-4 accent-[var(--color-primary)]"
        />
        {te.sound}
      </label>
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
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-[16px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[13px]"
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
              className={`cursor-pointer rounded-full border px-2.5 py-1 text-[12px] focus-within:ring-2 focus-within:ring-[var(--color-primary)] ${
                pos === p
                  ? "border-[var(--color-primary)] bg-[var(--color-accent-soft)] text-[var(--color-fg)]"
                  : "border-[var(--color-border)] text-[var(--color-muted)]"
              }`}
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
