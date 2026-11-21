"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { ArrowDown, ArrowUp, RotateCcw, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { Timecode } from "@/components/ui/Timecode";
import { formatTime, type EditorAsset, type PictureOverlay } from "@/lib/editor";
import {
  OVERLAY_RANGES,
  overlayBoxStyle,
  overlayLength,
  type OverlayKey,
} from "@/lib/editorOverlay";
import { animFrame } from "@/lib/editorFxPreview";
import { overlayAt } from "@/lib/editorMotion";
import { chromaFilterId, chromaSpec, type ChromaSpec } from "@/lib/editorChromaPreview";

/**
 * Picture overlays in the editor: the layer drawn in the preview, the picker
 * for the library's pictures and videos, and the inspector (when, where, how
 * big, how opaque). The editor decides what a change means (it clamps and
 * keeps the history); these only report them.
 */

const fieldClass =
  "rounded-[var(--ns-r-key)] w-full min-h-11 border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-base text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[13px]";
const quietBtn =
  "btn-quiet inline-flex items-center gap-1.5 px-3 py-1.5 text-xs";

// ── the preview layer ───────────────────────────────────────────────────────

/** Arrow key → a step of the centre, in whole steps (+x right, +y down). */
const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** CSS aspect-ratio of a library file ("1 / 1" when its size is not known). */
function aspectOf(a: EditorAsset | undefined): string {
  return a?.width && a?.height ? `${a.width} / ${a.height}` : "1 / 1";
}

/** An overlay's chroma key as an SVG filter (a rough picture of the export's
 *  `chromakey`, lib/editorChromaPreview.ts). Zero size, hidden from everyone. */
function ChromaDefs({ id, spec }: { id: string; spec: ChromaSpec }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
      className="pointer-events-none absolute"
      data-testid="chroma-filter"
    >
      <filter id={chromaFilterId(id)} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
        <feColorMatrix in="SourceGraphic" type="matrix" values={spec.toDistance} result="uv" />
        <feComponentTransfer in="uv" result="sq">
          <feFuncR type="table" tableValues={spec.square} />
          <feFuncG type="table" tableValues={spec.square} />
        </feComponentTransfer>
        <feColorMatrix in="sq" type="matrix" values={spec.sum} result="d2" />
        <feComponentTransfer in="d2" result="mask">
          <feFuncA type="table" tableValues={spec.alpha} />
        </feComponentTransfer>
        <feComposite in="SourceGraphic" in2="mask" operator="in" />
      </filter>
    </svg>
  );
}

function OverlayVideo({
  src,
  start,
  playhead,
  playing,
  opacity,
  filter,
  onError,
}: {
  src: string;
  start: number;
  playhead: number;
  playing: boolean;
  opacity: number;
  /** A CSS filter for the picture (the chroma key). */
  filter?: string;
  onError: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.muted = true; // an overlay is never heard, in the export either
    const target = Math.max(0, playhead - start);
    const seek = (to: number) => {
      try {
        v.currentTime = to;
      } catch {
        /* not loaded yet: loadedmetadata seeks */
      }
    };
    if (!playing) {
      v.pause?.();
      if (Math.abs((v.currentTime || 0) - target) > 0.05) seek(target);
    } else {
      if (Math.abs((v.currentTime || 0) - target) > 0.4) seek(target);
      if (v.paused) void v.play?.()?.catch?.(() => {});
    }
  }, [playhead, playing, start]);
  return (
    <video
      ref={ref}
      src={src}
      muted
      playsInline
      preload="auto"
      onLoadedMetadata={() => {
        const v = ref.current;
        if (v) v.currentTime = Math.max(0, playhead - start);
      }}
      onError={onError}
      className="block h-auto w-full"
      style={{ opacity, ...(filter ? { filter } : {}) }}
    />
  );
}

/**
 * The overlays on screen at the playhead, drawn in the preview box (the
 * parent clips what leaves the frame) with the same fractions the export
 * uses, plus a frame around the selected one: a real button a keyboard can
 * reach, whose arrow keys move the overlay (only while it has focus) and
 * which a pointer can drag.
 */
export function OverlayLayer({
  overlays,
  assets,
  selectedId,
  numberOf,
  playhead,
  playing,
  onNudge,
  onDrag,
  onDragEnd,
  onLinkError,
  frame,
}: {
  /** The frame's size, for the entrance / exit offsets (a share of its height). */
  frame?: { width: number; height: number };
  /** Those on screen at the playhead, bottom layer first. */
  overlays: readonly PictureOverlay[];
  assets: Record<string, EditorAsset>;
  selectedId: string | null;
  /** 1-based place in the document's list: its number, and its layer. */
  numberOf: (id: string) => number;
  playhead: number;
  playing: boolean;
  /** Whole steps (x, y); `big` for Shift. */
  onNudge: (id: string, dx: number, dy: number, big: boolean) => void;
  /** The centre while dragging, as fractions of the frame. */
  onDrag: (id: string, x: number, y: number) => void;
  onDragEnd: () => void;
  onLinkError: () => void;
}) {
  const { t } = useI18n();
  const to = t.editor.overlay;
  const drag = useRef<{
    x0: number;
    y0: number;
    cx: number;
    cy: number;
    w: number;
    h: number;
  } | null>(null);
  const selected = overlays.find((o) => o.id === selectedId) ?? null;
  const root = useRef<HTMLDivElement>(null);

  function onKey(e: KeyboardEvent<HTMLElement>, o: PictureOverlay) {
    const dir = ARROWS[e.key];
    if (!dir || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    onNudge(o.id, dir[0], dir[1], e.shiftKey);
  }

  function onDown(e: PointerEvent<HTMLElement>, o: PictureOverlay) {
    // The PREVIEW's size, not the frame button's offsetParent (that is the small,
    // transformed overlay box): the drag is measured in fractions of the video.
    const box = root.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = {
      x0: e.clientX,
      y0: e.clientY,
      cx: o.x,
      cy: o.y,
      w: box.width,
      h: box.height,
    };
  }

  function onMove(e: PointerEvent<HTMLElement>, o: PictureOverlay) {
    const d = drag.current;
    if (!d) return;
    onDrag(
      o.id,
      d.cx + (e.clientX - d.x0) / d.w,
      d.cy + (e.clientY - d.y0) / d.h,
    );
  }

  function onUp() {
    if (!drag.current) return;
    drag.current = null;
    onDragEnd();
  }

  return (
    <div ref={root} className="pointer-events-none absolute inset-0 z-0">
      {overlays.map((start) => {
        // With an end keyframe the picture is where the straight line between the two has it now.
        const o = { ...start, ...overlayAt(start, playhead) };
        const key = start.chroma ? chromaSpec(start.chroma) : null;
        const keyed = key ? `url(#${chromaFilterId(start.id)})` : undefined;
        const a = assets[o.asset_id];
        const src = a?.viewUrl ?? a?.thumbUrl ?? null;
        // The entrance / exit at the playhead (a rough picture; the export is the reference).
        const f = animFrame(o, playhead);
        const moving = f.dx !== 0 || f.dy !== 0 || f.scale !== 1;
        const style = {
          ...overlayBoxStyle(o),
          ...(moving
            ? {
                transform: `translate(${f.dx * 100}cqw, ${(f.dy * 100 * (frame ? frame.height / frame.width : 1))}cqw) translate(-50%, -50%) scale(${f.scale})`,
              }
            : {}),
          ...(f.opacity !== 1 ? { opacity: f.opacity } : {}),
          pointerEvents: "none" as const,
          ...(a?.width && a?.height
            ? { aspectRatio: `${a.width} / ${a.height}` }
            : {}),
        };
        return (
          <div
            key={o.id}
            data-overlay={o.id}
            data-testid="overlay-item"
            className="overflow-hidden"
            style={{ ...style, zIndex: numberOf(o.id) }}
          >
            {key ? <ChromaDefs id={start.id} spec={key} /> : null}
            {src && a?.kind === "video" ? (
              <OverlayVideo
                src={src}
                start={o.start_s}
                playhead={playhead}
                playing={playing}
                opacity={o.opacity}
                filter={keyed}
                onError={onLinkError}
              />
            ) : src ? (
              // eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived library link
              <img
                src={src}
                alt=""
                className="block h-auto w-full"
                style={{ opacity: o.opacity, ...(keyed ? { filter: keyed } : {}) }}
                onError={onLinkError}
              />
            ) : (
              <span
                className="flex size-full min-h-6 items-center justify-center border border-dashed border-white/60 bg-black/30 p-1 text-center text-[10px] leading-tight text-white"
                style={{ opacity: o.opacity }}
              >
                {to.noPreview}
              </span>
            )}
          </div>
        );
      })}
      {selected ? (
        <div
          data-testid="overlay-frame"
          className="pointer-events-none"
          style={{
            ...overlayBoxStyle(selected),
            // The same shape as the picture it frames (a library file's own size).
            aspectRatio: aspectOf(assets[selected.asset_id]),
            zIndex: 1000,
          }}
        >
          <button
            type="button"
            data-overlay-frame={selected.id}
            aria-label={fmt(to.handle, { n: numberOf(selected.id) })}
            onKeyDown={(e) => onKey(e, selected)}
            onPointerDown={(e) => onDown(e, selected)}
            onPointerMove={(e) => onMove(e, selected)}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            className="pointer-events-auto absolute left-1/2 top-1/2 block h-full min-h-11 w-full min-w-11 -translate-x-1/2 -translate-y-1/2 cursor-move touch-none border-2 border-dashed border-white bg-transparent p-0 outline-none [box-shadow:0_0_0_1px_rgba(0,0,0,0.7)] focus-visible:border-solid focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
          />
        </div>
      ) : null}
    </div>
  );
}

// ── the picker ──────────────────────────────────────────────────────────────

export function OverlayPicker({
  images,
  videos,
  onPick,
  onClose,
}: {
  images: readonly EditorAsset[];
  videos: readonly EditorAsset[];
  onPick: (a: EditorAsset) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const to = t.editor.overlay;
  const heading = useId();
  const groups = [
    { key: "image", label: to.pickerPictures, files: images },
    { key: "video", label: to.pickerVideos, files: videos },
  ].filter((g) => g.files.length > 0);
  return (
    <section
      aria-labelledby={heading}
      className="panel flex flex-col gap-2 p-4 sm:p-5"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id={heading} className="m-0 text-sm font-semibold">
          {to.addTitle}
        </h3>
        <button type="button" onClick={onClose} className={quietBtn}>
          {t.editor.close}
        </button>
      </div>
      {groups.length === 0 ? (
        <p className="m-0 text-xs text-[var(--color-muted)]">{to.noFiles}</p>
      ) : (
        groups.map((g) => (
          <div key={g.key} className="flex flex-col gap-1.5">
            <h4 className="m-0 text-xs font-semibold text-[var(--color-muted)]">
              {g.label}
            </h4>
            <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3">
              {g.files.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => onPick(a)}
                    className="flex min-h-11 w-full min-w-0 flex-col gap-1 rounded-[var(--ns-r-key)] border border-[var(--color-border)] p-2 text-left text-xs"
                  >
                    {a.thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived library link
                      <img
                        src={a.thumbUrl}
                        alt=""
                        className="h-12 w-full rounded-[var(--ns-r-chip)] object-cover"
                      />
                    ) : null}
                    <span className="truncate text-[var(--color-fg)]">
                      {a.name ?? to.untitled}
                    </span>
                    {g.key === "video" ? (
                      <span className="text-[var(--color-muted)]">
                        <Timecode value={a.durationS} format="duration" />
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

// ── the inspector ───────────────────────────────────────────────────────────

export function SecondsField({
  label,
  value,
  min,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const v = Number(draft.replace(",", "."));
    // An empty or unreadable box goes back to the value; it never means 0.
    if (draft.trim() !== "" && Number.isFinite(v) && v !== value) onCommit(v);
    else setDraft(String(value));
  };
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-muted)]">
      {label}
      <input
        type="number"
        inputMode="decimal"
        value={draft}
        min={min}
        step={0.1}
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

/** A number kept as whole percent in the controls, a fraction in the document. */
function PercentControl({
  label,
  value,
  field,
  onChange,
}: {
  label: string;
  /** The document's fraction. */
  value: number;
  field: OverlayKey;
  onChange: (fraction: number) => void;
}) {
  const { t } = useI18n();
  const to = t.editor.overlay;
  const range = OVERLAY_RANGES[field];
  const lo = Math.round(range.min * 100);
  const hi = Math.round(range.max * 100);
  const percent = Math.round(value * 100);
  const [draft, setDraft] = useState(String(percent));
  useEffect(() => setDraft(String(percent)), [percent]);
  const commit = () => {
    const v = Number(draft.replace(",", "."));
    if (draft.trim() !== "" && Number.isFinite(v) && Math.round(v) !== percent)
      onChange(v / 100);
    else setDraft(String(percent));
  };
  const text = fmt(to.percent, { v: percent });
  return (
    <div className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
      <span>
        {label} · {text}
      </span>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={lo}
          max={hi}
          step={1}
          value={Math.min(hi, Math.max(lo, percent))}
          aria-label={label}
          aria-valuetext={text}
          onChange={(e) => onChange(Number(e.target.value) / 100)}
          className="h-11 min-w-0 flex-1 accent-[var(--color-primary)]"
        />
        <input
          type="number"
          inputMode="decimal"
          value={draft}
          min={lo}
          max={hi}
          step={1}
          aria-label={fmt(to.numberLabel, { name: label })}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
          className={`${fieldClass} !w-20 shrink-0`}
        />
      </div>
    </div>
  );
}

export function OverlayInspector({
  n,
  total,
  overlay,
  name,
  kind,
  warning,
  onChange,
  onReset,
  onToPlayhead,
  onLayer,
  extra,
  onDelete,
}: {
  n: number;
  total: number;
  overlay: PictureOverlay;
  name: string;
  kind: EditorAsset["kind"];
  warning: "past_end" | "cut_end" | "invisible" | null;
  /** `burst` names a run of small changes that is one undo step. */
  onChange: (
    patch: Partial<Omit<PictureOverlay, "id" | "asset_id">>,
    burst?: string,
  ) => void;
  onReset: () => void;
  onToPlayhead: () => void;
  onLayer: (by: -1 | 1) => void;
  /** More sections of this overlay (entrance / exit, move, chroma key), under the basics. */
  extra?: ReactNode;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const te = t.editor;
  const to = te.overlay;
  const len = overlayLength(overlay);
  const field = (key: OverlayKey, label: string) => (
    <PercentControl
      label={label}
      value={overlay[key]}
      field={key}
      onChange={(v) => onChange({ [key]: v }, `${overlay.id}:${key}`)}
    />
  );
  return (
    <>
      <h2
        tabIndex={-1}
        data-overlay-heading=""
        className="m-0 text-sm font-semibold outline-none"
      >
        {fmt(to.heading, { n })}
      </h2>
      <p className="m-0 truncate text-xs text-[var(--color-muted)]">
        {fmt(to.file, {
          name,
          kind: kind === "video" ? to.kindVideo : to.kindImage,
        })}{" "}
        · <Timecode value={len} format="duration" label={formatTime(len)} />
      </p>
      {warning ? (
        <p role="status" className="m-0 text-xs text-[var(--color-warn)]">
          {warning === "past_end"
            ? to.pastEnd
            : warning === "cut_end"
              ? to.cutEnd
              : to.invisible}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <SecondsField
          label={to.start}
          value={overlay.start_s}
          min={0}
          onCommit={(v) => onChange({ start_s: v })}
        />
        <SecondsField
          label={to.end}
          value={overlay.end_s}
          min={overlay.start_s}
          onCommit={(v) => onChange({ end_s: v })}
        />
      </div>
      <button
        type="button"
        onClick={onToPlayhead}
        className={`${quietBtn} min-h-11 self-start`}
      >
        {to.toPlayhead}
      </button>
      {field("x", to.x)}
      {field("y", to.y)}
      {field("w", to.size)}
      {field("opacity", to.opacity)}
      <p className="m-0 text-xs text-[var(--color-muted)]">{to.keysHint}</p>
      {kind === "video" ? (
        <p className="m-0 text-xs text-[var(--color-muted)]">{to.videoNote}</p>
      ) : null}
      {extra}
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onLayer(1)}
            disabled={n >= total}
            className={`${quietBtn} min-h-11`}
          >
            <ArrowUp className="size-3.5" aria-hidden />
            {to.forward}
          </button>
          <button
            type="button"
            onClick={() => onLayer(-1)}
            disabled={n <= 1}
            className={`${quietBtn} min-h-11`}
          >
            <ArrowDown className="size-3.5" aria-hidden />
            {to.backward}
          </button>
        </div>
        <p className="m-0 text-xs text-[var(--color-muted)]">
          {fmt(to.layer, { n, total })}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onReset}
          className={`${quietBtn} min-h-11`}
        >
          <RotateCcw className="size-3.5" aria-hidden />
          {to.reset}
        </button>
        <button
          type="button"
          onClick={onDelete}
          className={`${quietBtn} min-h-11 text-[var(--color-fail)]`}
        >
          <Trash2 className="size-3.5" aria-hidden />
          {to.delete}
        </button>
      </div>
    </>
  );
}
