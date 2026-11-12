"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { SoundWave } from "./SoundWave";
import { Timecode } from "@/components/ui/Timecode";
import { snapTargets, snapTrimValue } from "@/lib/editor-timeline-view";
import type { TimelineView } from "./useTimelineView";
import type { ShapeLayer } from "@/lib/editorShapes";
import type { Marks } from "@/lib/editorRange";
import type { EditTool } from "./EditCore";
import { hasItem, marqueeHits, sameItem, type Box, type Item } from "@/lib/editorSelection";
import {
  clipEnd,
  clipLength,
  crossfadeOf,
  formatTime,
  gapOf,
  soundLength,
  type EditorAsset,
  type PictureOverlay,
  type SoundClip,
  type TextClip,
  type VideoClip,
} from "@/lib/editor";

/** A drag or a key on a roll, slip or slide handle: `delta` is timeline seconds from where the gesture started
 *  (a roll moves the cut into clip `id`, a slide moves clip `id`), or for a slip SOURCE seconds (later when
 *  positive). The strip only reports it; the editor runs the model's operation, which holds it to its limits. */
export type ToolOp = { tool: Exclude<EditTool, "trim">; id: string; delta: number };

export type Selection = {
  kind: "clip" | "text" | "sound" | "overlay" | "shape";
  id: string;
} | null;

/** Lanes so items that share time sit one above the other, not on top of each other. */
export function textLanes(
  texts: readonly { id: string; start_s: number; end_s: number }[],
): Map<string, number> {
  const ends: number[] = [];
  const lane = new Map<string, number>();
  for (const t of [...texts].sort(
    (a, b) => a.start_s - b.start_s || a.id.localeCompare(b.id),
  )) {
    let i = ends.findIndex((e) => e <= t.start_s);
    if (i < 0) i = ends.length;
    ends[i] = t.end_s;
    lane.set(t.id, i);
  }
  return lane;
}

/**
 * Where the ruler's ticks fall: a whole number of seconds apart, as many as
 * leave each label about 56px of room, so every tick is a real position on the
 * timeline (IDENTITY.md: a ruler is never decoration). `div` is how many
 * minor ticks sit between two labelled ones, each also on a whole or
 * quarter second. Pure; tested directly.
 */
export function rulerTicks(total: number, widthPx: number): { step: number; div: number; marks: number[] } | null {
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(widthPx) || widthPx <= 0) return null;
  const pxPerS = widthPx / total;
  const STEPS: [number, number][] = [
    [1, 4],
    [2, 4],
    [5, 5],
    [10, 5],
    [15, 5],
    [30, 6],
    [60, 6],
    [120, 4],
    [300, 5],
    [600, 5],
  ];
  const [step, div] = STEPS.find(([s]) => s * pxPerS >= 56) ?? STEPS[STEPS.length - 1];
  const marks: number[] = [];
  for (let m = 0; m <= total + 1e-9; m += step) marks.push(m);
  return { step, div, marks };
}

const soundSpan = (x: SoundClip) => ({
  id: x.id,
  start_s: x.start_s,
  end_s: x.start_s + soundLength(x),
});

/**
 * The timeline: the picture's clips end to end (a cross-faded clip starts
 * over the end of the one before it), the music and sounds and the texts
 * under them, and the playhead. A selected clip gets two trim handles — sliders a keyboard can
 * move (arrow = one frame, Shift + arrow = one second, Home / End = as far as
 * the source allows) and a pointer can drag. The strip only reports changes;
 * the editor decides (and the model clamps them).
 */
export function TimelineStrip({
  clips,
  texts,
  sounds,
  overlays = [],
  shapes = [],
  total,
  fps,
  playhead,
  selected,
  assets,
  onSelect,
  onTrim,
  onTrimEnd,
  view,
  beats = [],
  tool = "trim",
  marks,
  onToolEdit,
  onToolEditEnd,
  onCloseGap,
  multi = [],
  onToggle,
  onMarquee,
  selectMode = false,
  onSelectMode,
}: {
  clips: readonly VideoClip[];
  texts: readonly TextClip[];
  /** Pictures / videos over the picture, in layer order. */
  overlays?: readonly PictureOverlay[];
  /** Drawn shapes over the picture, in layer order. */
  shapes?: readonly ShapeLayer[];
  sounds: readonly SoundClip[];
  total: number;
  fps: number;
  playhead: number;
  selected: Selection;
  assets: Record<string, EditorAsset>;
  onSelect: (s: Selection) => void;
  /** A live trim (dragging or a key): source seconds for one edge. `commit` false while dragging. */
  onTrim: (
    id: string,
    edge: "in" | "out",
    value: number,
    commit: boolean,
  ) => void;
  /** A drag ended: the last value is the one to keep in the history. */
  onTrimEnd: () => void;
  /** Zoom and snap (useTimelineView). Without it the strip fits the window and does not snap. */
  view?: TimelineView;
  /** Beat markers (timeline seconds): drawn over the clips' lane, and trims snap to them. */
  beats?: readonly number[];
  /** The timeline tool: trim (edge handles, the default), roll (cut handles), slip or slide (a handle on the clip). */
  tool?: EditTool;
  /** The in / out marks, drawn over the lanes (editor state, never saved). */
  marks?: Marks;
  /** A roll, slip or slide gesture: `commit` false while dragging (the editor keeps one undo step for it). */
  onToolEdit?: (op: ToolOp, commit: boolean) => void;
  /** A roll, slip or slide drag ended. */
  onToolEditEnd?: () => void;
  /** Close the gap before clip `id` (a ripple delete of the black a lift left). */
  onCloseGap?: (id: string) => void;
  /** Every selected item when there are several (`selected` is the one the inspector shows); empty = just `selected`. */
  multi?: readonly Item[];
  /** Shift / Ctrl / Cmd + click or a tap in select mode: the item added to the selection or taken out. A long press
   *  (`via` "hold") turns select mode on and never takes the item out. */
  onToggle?: (item: Item, via?: "hold") => void;
  /** A marquee drag on an empty part of the strip ended: the items its box touched (`add`: Shift / Ctrl / Cmd held). */
  onMarquee?: (items: Item[], add: boolean) => void;
  /** Select mode (the touch way): a tap adds or takes out instead of selecting just that item. */
  selectMode?: boolean;
  /** A long press on an item turns select mode on. */
  onSelectMode?: (on: boolean) => void;
}) {
  const { t } = useI18n();
  const te = t.editor;
  const strip = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    id: string;
    edge: "in" | "out";
    x0: number;
    v0: number;
    pxPerS: number;
    speed: number;
    baseTime: number;
    targets: number[];
    touch: boolean;
  } | null>(null);
  const toolDrag = useRef<{ tool: ToolOp["tool"]; id: string; x0: number; pxPerS: number; speed: number } | null>(null);
  // Where a trim drag has snapped to (a guide line while it holds), or nothing.
  const [guide, setGuide] = useState<number | null>(null);
  const span = Math.max(total, 0.001);
  const pct = (s: number) => `${(Math.max(0, s) / span) * 100}%`;
  const lanes = textLanes(texts);
  const laneCount = Math.max(1, ...[...lanes.values()].map((l) => l + 1));
  const oLanes = textLanes(overlays);
  const oLaneCount = Math.max(1, ...[...oLanes.values()].map((l) => l + 1));
  const hLanes = textLanes(shapes);
  const hLaneCount = Math.max(1, ...[...hLanes.values()].map((l) => l + 1));
  const sLanes = textLanes(sounds.map(soundSpan));
  const sLaneCount = Math.max(1, ...[...sLanes.values()].map((l) => l + 1));
  const frame = 1 / fps;
  // The strip's own width decides the label spacing; a server render and a test
  // (no ResizeObserver) use a phone-sized default.
  const [width, setWidth] = useState(320);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const read = () => setWidth(el.getBoundingClientRect().width || 320);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ticks = rulerTicks(total, width);

  // ── selecting several: Shift / Ctrl / Cmd + click, a tap in select mode, a long press, a marquee ──
  const isLit = (x: Item) => sameItem(selected, x) || hasItem(multi, x);
  /** The key of the item a long press just toggled: the click that follows the press must not select it alone. */
  const pressed = useRef<string | null>(null);
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const endHold = () => {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  };
  useEffect(() => endHold, []);
  /** What every item button of every lane gets: the click (one, or added / taken out) and the touch long press. */
  const itemProps = (x: Item) => ({
    "data-item-kind": x.kind,
    "data-item-id": x.id,
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      if (pressed.current === `${x.kind}:${x.id}`) {
        pressed.current = null;
        return;
      }
      if (onToggle && (e.shiftKey || e.ctrlKey || e.metaKey || selectMode)) onToggle(x);
      else onSelect(x);
    },
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType !== "touch" || !onToggle) return;
      endHold();
      // Half a second held still: select mode, with this item added (a phone has no Shift key).
      hold.current = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          hold.current = null;
          pressed.current = `${x.kind}:${x.id}`;
          onSelectMode?.(true);
          onToggle(x, "hold");
        }, 500),
      };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const h = hold.current;
      // moving is scrolling the timeline, not holding
      if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > 10) endHold();
    },
    onPointerUp: endHold,
    onPointerCancel: endHold,
    onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
      // the phone's own long-press menu would cover the timeline
      if (hold.current || pressed.current) e.preventDefault();
    },
  });
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const boxStart = useRef<{ x0: number; y0: number; add: boolean; id: number } | null>(null);
  function onLanesDown(e: PointerEvent<HTMLDivElement>) {
    // A mouse or pen drag on an empty part of the strip (not a clip, a handle or a button); a finger scrolls.
    if (!onMarquee || e.pointerType === "touch" || e.button !== 0) return;
    if ((e.target as Element).closest("button, [role=slider], input, a")) return;
    const r = strip.current?.getBoundingClientRect();
    if (!r) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    boxStart.current = { x0: e.clientX - r.left, y0: e.clientY - r.top, add: e.shiftKey || e.ctrlKey || e.metaKey, id: e.pointerId };
  }
  function onLanesMove(e: PointerEvent<HTMLDivElement>) {
    const b = boxStart.current;
    const r = strip.current?.getBoundingClientRect();
    if (!b || !r) return;
    const x1 = e.clientX - r.left;
    const y1 = e.clientY - r.top;
    if (!box && Math.hypot(x1 - b.x0, y1 - b.y0) < 4) return;
    setBox({ x0: b.x0, y0: b.y0, x1, y1 });
  }
  function onLanesUp() {
    const b = boxStart.current;
    boxStart.current = null;
    const drawn = box;
    setBox(null);
    const el = strip.current;
    if (!b || !drawn || !el || !onMarquee) return;
    const r = el.getBoundingClientRect();
    const boxes: Box[] = Array.from(el.querySelectorAll<HTMLElement>("[data-item-kind]")).map((n) => {
      const k = n.getBoundingClientRect();
      return {
        item: { kind: n.dataset.itemKind as Item["kind"], id: n.dataset.itemId ?? "" },
        left: k.left - r.left,
        right: k.right - r.left,
        top: k.top - r.top,
        bottom: k.bottom - r.top,
      };
    });
    onMarquee(marqueeHits(boxes, drawn.x0, drawn.y0, drawn.x1, drawn.y1), b.add);
  }

  function onHandleKey(
    e: KeyboardEvent<HTMLElement>,
    c: VideoClip,
    edge: "in" | "out",
  ) {
    const step = e.shiftKey ? 1 : frame;
    const now = edge === "in" ? c.in_s : c.out_s;
    const src = assets[c.asset_id]?.durationS ?? null;
    let next: number | null = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = now - step;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = now + step;
    else if (e.key === "Home") next = edge === "in" ? 0 : c.in_s;
    else if (e.key === "End") next = edge === "in" ? c.out_s : (src ?? c.out_s);
    if (next === null) return;
    e.preventDefault();
    onTrim(c.id, edge, next, true);
  }

  function onHandleDown(
    e: PointerEvent<HTMLElement>,
    c: VideoClip,
    edge: "in" | "out",
  ) {
    const w = strip.current?.getBoundingClientRect().width ?? 0;
    if (!w) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = {
      id: c.id,
      edge,
      x0: e.clientX,
      v0: edge === "in" ? c.in_s : c.out_s,
      pxPerS: w / span,
      speed: c.speed,
      // The clip's end is what moves on the timeline for either handle (the in handle shrinks the clip from its end side); clips after this one ripple, so they are no target.
      baseTime: clipEnd(c),
      targets: snapTargets({ clips, texts, sounds, playhead, skipClipsAfter: c.id, beats }),
      touch: e.pointerType === "touch",
    };
  }

  function onHandleMove(e: PointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d) return;
    // Pixels are timeline seconds; a trim moves SOURCE seconds (× speed); snapping pulls it to a target.
    const { value, snappedTo } = snapTrimValue({
      edge: d.edge,
      v0: d.v0,
      speed: d.speed,
      baseTime: d.baseTime,
      dx: e.clientX - d.x0,
      pxPerS: d.pxPerS,
      targets: d.targets,
      snap: view?.snap ?? false,
      touch: d.touch,
    });
    setGuide(snappedTo);
    onTrim(d.id, d.edge, Math.round(value * fps) / fps, false);
  }

  function onHandleUp() {
    if (!drag.current) return;
    drag.current = null;
    setGuide(null);
    onTrimEnd();
  }

  // ── roll, slip and slide handles ──
  function onToolKey(e: KeyboardEvent<HTMLElement>, op: Omit<ToolOp, "delta">, speed: number, now: number) {
    const step = e.shiftKey ? 1 : frame;
    let dir = 0;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") dir = -1;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") dir = 1;
    if (!dir) return;
    e.preventDefault();
    // A slip moves through the SOURCE: one frame of the clip is `speed` frames of its file. The step lands on the
    // frame grid (the document keeps milliseconds, so stepping a rounded value would drift a millisecond a frame).
    const by = dir * step * (op.tool === "slip" ? speed : 1);
    const target = Math.round((now + by) * fps) / fps;
    onToolEdit?.({ ...op, delta: Math.abs(target - now) > 1e-9 ? target - now : by }, true);
  }
  function onToolDown(e: PointerEvent<HTMLElement>, op: Omit<ToolOp, "delta">, speed: number) {
    const w = strip.current?.getBoundingClientRect().width ?? 0;
    if (!w) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    toolDrag.current = { ...op, x0: e.clientX, pxPerS: w / span, speed };
  }
  function onToolMove(e: PointerEvent<HTMLElement>) {
    const d = toolDrag.current;
    if (!d) return;
    const dt = Math.round(((e.clientX - d.x0) / d.pxPerS) * fps) / fps;
    // Dragging a slip moves the PICTURE with the pointer: to the right shows an earlier part of the file.
    onToolEdit?.({ tool: d.tool, id: d.id, delta: d.tool === "slip" ? -dt * d.speed : dt }, false);
  }
  function onToolUp() {
    if (!toolDrag.current) return;
    toolDrag.current = null;
    onToolEditEnd?.();
  }

  return (
    <div
      ref={view?.setScroller}
      className="overflow-x-auto pb-1"
      role="group"
      aria-label={te.timeline}
      data-editor-timeline=""
    >
      <div
        ref={strip}
        onPointerDown={onLanesDown}
        onPointerMove={onLanesMove}
        onPointerUp={onLanesUp}
        onPointerCancel={() => {
          boxStart.current = null;
          setBox(null);
        }}
        className="ns-lanes-root relative flex flex-col gap-1.5"
        style={{ minWidth: `max(${(view?.zoom ?? 1) * 100}%, ${clips.length * 122}px)` }}
      >
        {ticks && (
          // Seconds ticks under which the lanes sit: the same scale as the clips below.
          <div
            aria-hidden
            className="ns-ruler"
            style={{ height: 24, "--ruler-major": `${(ticks.step / span) * 100}%`, "--ruler-div": ticks.div } as CSSProperties}
          >
            {ticks.marks.map((m) => (
              <span
                key={m}
                className="absolute top-0 whitespace-nowrap pl-1 text-xs leading-[12px] text-[var(--color-muted)]"
                style={{ left: pct(m) }}
              >
                <Timecode value={m} format="duration" />
              </span>
            ))}
          </div>
        )}
        <div
          className="relative h-14 w-full"
          aria-label={te.clipsTrack}
          role="list"
        >
          {beats.map((b, i) => (
            <span
              key={`beat-${i}-${b}`}
              aria-hidden
              data-testid="beat-marker"
              className="pointer-events-none absolute -top-1 z-10 h-2 w-px bg-[var(--ns-amber)]"
              style={{ left: pct(b) }}
            />
          ))}
          {clips.map((c, i) =>
            gapOf(c) > 0 ? (
              // Black before clip i + 1 (what a lift leaves): its own button closes it.
              <div
                key={`gap-${c.id}`}
                role="listitem"
                data-testid="timeline-gap"
                className="absolute top-0 h-full px-px"
                style={{ left: pct(c.start_s - gapOf(c)), width: pct(gapOf(c)) }}
              >
                <button
                  type="button"
                  onClick={() => onCloseGap?.(c.id)}
                  aria-label={fmt(te.core.marks.closeGap, { n: i + 1, length: formatTime(gapOf(c)) })}
                  className="size-full min-w-0 truncate rounded-[var(--ns-r-key)] border border-dashed border-[var(--color-border)] bg-[repeating-linear-gradient(135deg,var(--color-panel-2)_0_6px,transparent_6px_12px)] px-1 text-left text-xs text-[var(--color-muted)]"
                >
                  {te.core.marks.holdName}
                </button>
              </div>
            ) : null,
          )}
          {clips.map((c, i) => {
            const len = clipLength(c);
            const on = selected?.kind === "clip" && selected.id === c.id;
            const hi = on || hasItem(multi, { kind: "clip", id: c.id });
            const name = assets[c.asset_id]?.name ?? te.untitledVideo;
            const src = assets[c.asset_id]?.durationS ?? undefined;
            const x = crossfadeOf(c);
            const label = fmt(te.clipLabel, {
              n: i + 1,
              name,
              length: formatTime(len),
            });
            return (
              <div
                key={c.id}
                role="listitem"
                className={`absolute top-0 h-full px-px ${on ? "z-10" : ""}`}
                style={{ left: pct(c.start_s), width: pct(len) }}
              >
                <button
                  type="button"
                  {...itemProps({ kind: "clip", id: c.id })}
                  aria-pressed={hi}
                  aria-label={
                    x > 0
                      ? `${label}, ${fmt(te.clipCrossfade, { s: x })}`
                      : label
                  }
                  className={`relative flex size-full min-w-0 select-none flex-col justify-between overflow-hidden rounded-[var(--ns-r-key)] border px-1.5 py-1 text-left text-xs [-webkit-touch-callout:none] ${
                    hi
                      ? "border-[var(--color-primary)] bg-[var(--color-accent-soft)] text-[var(--color-fg)]"
                      : "border-[var(--color-border)] bg-[var(--color-panel-2)] text-[var(--color-muted)]"
                  }`}
                >
                  {x > 0 ? (
                    // The cross-fade: the part of this clip that overlaps
                    // the end of the one before it.
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-[var(--color-primary)] to-transparent opacity-40"
                      style={{ width: `${(x / len) * 100}%` }}
                    />
                  ) : null}
                  <span className="truncate">{name}</span>
                  {c.speed !== 1 ? (
                    <span className="font-semibold text-[var(--color-primary)]">
                      {fmt(te.speedValue, { x: c.speed })}
                    </span>
                  ) : null}
                </button>
                {on && tool !== "trim" ? (
                  <ToolHandles
                    tool={tool}
                    clips={clips}
                    index={i}
                    src={src}
                    onKey={onToolKey}
                    onDown={onToolDown}
                    onMove={onToolMove}
                    onUp={onToolUp}
                  />
                ) : null}
                {on && tool === "trim" ? (
                  <>
                    {(["in", "out"] as const).map((edge) => (
                      <span
                        key={edge}
                        role="slider"
                        tabIndex={0}
                        aria-label={fmt(
                          edge === "in" ? te.trimStart : te.trimEnd,
                          { n: i + 1 },
                        )}
                        aria-valuemin={edge === "in" ? 0 : c.in_s}
                        aria-valuemax={edge === "in" ? c.out_s : src}
                        aria-valuenow={edge === "in" ? c.in_s : c.out_s}
                        aria-valuetext={formatTime(
                          edge === "in" ? c.in_s : c.out_s,
                        )}
                        aria-describedby="editor-trim-keys"
                        onKeyDown={(e) => onHandleKey(e, c, edge)}
                        onPointerDown={(e) => onHandleDown(e, c, edge)}
                        onPointerMove={onHandleMove}
                        onPointerUp={onHandleUp}
                        onPointerCancel={onHandleUp}
                        data-edge={edge}
                        className={`ns-trim-handle absolute top-0 z-10 flex h-full cursor-ew-resize touch-none items-center justify-center rounded-[var(--ns-r-chip)] bg-[var(--color-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-fg)] ${
                          edge === "in" ? "left-0" : "right-0"
                        }`}
                      >
                        <span
                          className="h-5 w-0.5 rounded-[1px] bg-[var(--color-on-accent)]"
                          aria-hidden
                        />
                      </span>
                    ))}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
        {overlays.length ? (
          <div
            className="relative w-full"
            style={{ height: `calc(var(--ns-lane-step) * ${oLaneCount})` }}
            aria-label={te.overlay.track}
            role="list"
          >
            {overlays.map((o, i) => {
              const on = isLit({ kind: "overlay", id: o.id });
              const name = assets[o.asset_id]?.name ?? te.overlay.untitled;
              return (
                <div
                  key={o.id}
                  role="listitem"
                  className="absolute h-[var(--ns-lane-h)]"
                  style={{
                    left: pct(o.start_s),
                    width: pct(o.end_s - o.start_s),
                    top: `calc(var(--ns-lane-step) * ${oLanes.get(o.id) ?? 0})`,
                  }}
                >
                  <button
                    type="button"
                    {...itemProps({ kind: "overlay", id: o.id })}
                    aria-pressed={on}
                    aria-label={fmt(te.overlay.clipLabel, {
                      n: i + 1,
                      name,
                      from: formatTime(o.start_s),
                      to: formatTime(o.end_s),
                    })}
                    className={`size-full select-none truncate rounded-[var(--ns-r-chip)] border px-1.5 text-left text-xs [-webkit-touch-callout:none] ${
                      on
                        ? "border-[var(--color-primary)] bg-[var(--color-accent-soft)] text-[var(--color-fg)]"
                        : "border-[var(--color-border)] bg-[var(--color-panel-2)] text-[var(--color-muted)]"
                    }`}
                  >
                    {name}
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        {shapes.length ? (
          <div
            className="relative w-full"
            style={{ height: `calc(var(--ns-lane-step) * ${hLaneCount})` }}
            aria-label={te.shapes.track}
            role="list"
          >
            {shapes.map((h, i) => {
              const on = isLit({ kind: "shape", id: h.id });
              const kind = te.shapes.kinds[h.kind];
              return (
                <div
                  key={h.id}
                  role="listitem"
                  className="absolute h-[var(--ns-lane-h)]"
                  style={{
                    left: pct(h.start_s),
                    width: pct(h.end_s - h.start_s),
                    top: `calc(var(--ns-lane-step) * ${hLanes.get(h.id) ?? 0})`,
                  }}
                >
                  <button
                    type="button"
                    {...itemProps({ kind: "shape", id: h.id })}
                    aria-pressed={on}
                    aria-label={fmt(te.shapes.clipLabel, {
                      n: i + 1,
                      kind,
                      from: formatTime(h.start_s),
                      to: formatTime(h.end_s),
                    })}
                    className={`size-full select-none truncate rounded-[var(--ns-r-chip)] border px-1.5 text-left text-xs [-webkit-touch-callout:none] ${
                      on
                        ? "border-[var(--color-primary)] bg-[var(--color-accent-soft)] text-[var(--color-fg)]"
                        : "border-[var(--color-border)] bg-[var(--color-panel-2)] text-[var(--color-muted)]"
                    }`}
                  >
                    {h.kind === "pill" && h.text ? h.text : kind}
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        {sounds.length ? (
          <div
            className="relative w-full"
            style={{ height: `calc(var(--ns-lane-step) * ${sLaneCount})` }}
            aria-label={te.soundsTrack}
            role="list"
          >
            {sounds.map((x) => {
              const on = isLit({ kind: "sound", id: x.id });
              const end = x.start_s + soundLength(x);
              const name = assets[x.asset_id]?.name ?? te.untitledSound;
              return (
                <div
                  key={x.id}
                  role="listitem"
                  className="absolute h-[var(--ns-lane-h)]"
                  style={{
                    left: pct(x.start_s),
                    width: pct(end - x.start_s),
                    top: `calc(var(--ns-lane-step) * ${sLanes.get(x.id) ?? 0})`,
                  }}
                >
                  <button
                    type="button"
                    {...itemProps({ kind: "sound", id: x.id })}
                    aria-pressed={on}
                    aria-label={
                      fmt(te.soundClipLabel, {
                        name,
                        from: formatTime(x.start_s),
                        to: formatTime(end),
                      }) +
                      (x.role === "speech" ? `, ${te.roleSpeechShort}` : "") +
                      (x.duck
                        ? `, ${fmt(te.duckLabel, { db: x.duck.amount_db })}`
                        : "")
                    }
                    className={`relative size-full select-none overflow-hidden truncate rounded-[var(--ns-r-chip)] [-webkit-touch-callout:none] border px-1.5 text-left text-xs ${
                      on
                        ? "border-[var(--color-primary)] bg-[var(--color-accent-soft)] text-[var(--color-fg)]"
                        : "border-[var(--color-border)] bg-[var(--color-panel-2)] text-[var(--color-muted)]"
                    }`}
                  >
                    <SoundWave sound={x} asset={assets[x.asset_id]} />
                    <span className="relative">
                      ♪ {name}
                      {x.role === "speech" ? ` · ${te.roleSpeechShort}` : ""}
                      {x.duck
                        ? ` · ${fmt(te.duckBadge, { db: x.duck.amount_db })}`
                        : ""}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        <div
          className="relative w-full"
          style={{ height: `calc(var(--ns-lane-step) * ${laneCount})` }}
          aria-label={te.textTrack}
          role="list"
        >
          {texts.map((x) => {
            const on = isLit({ kind: "text", id: x.id });
            return (
              <div
                key={x.id}
                role="listitem"
                className="absolute h-[var(--ns-lane-h)]"
                style={{
                  left: pct(x.start_s),
                  width: pct(x.end_s - x.start_s),
                  top: `calc(var(--ns-lane-step) * ${lanes.get(x.id) ?? 0})`,
                }}
              >
                <button
                  type="button"
                  {...itemProps({ kind: "text", id: x.id })}
                  aria-pressed={on}
                  aria-label={fmt(te.textClipLabel, {
                    text: x.text || "…",
                    from: formatTime(x.start_s),
                    to: formatTime(x.end_s),
                  })}
                  className={`size-full select-none truncate rounded-[var(--ns-r-chip)] border px-1.5 text-left text-xs [-webkit-touch-callout:none] ${
                    on
                      ? "border-[var(--color-primary)] bg-[var(--color-accent-soft)] text-[var(--color-fg)]"
                      : "border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-muted)]"
                  }`}
                >
                  {x.text || "…"}
                </button>
              </div>
            );
          })}
        </div>
        {marks && (marks.in !== null || marks.out !== null) ? (
          // The marked range over every lane, and its two edges (I / O).
          <>
            <span
              aria-hidden
              data-testid="mark-range"
              className="pointer-events-none absolute top-0 z-10 h-full bg-[var(--color-primary)] opacity-15"
              style={{
                left: pct(Math.min(marks.in ?? 0, marks.out ?? span)),
                width: pct(Math.abs((marks.out ?? span) - (marks.in ?? 0))),
              }}
            />
            {(["in", "out"] as const).map((k) =>
              marks[k] === null ? null : (
                <span
                  key={k}
                  aria-hidden
                  data-testid={`mark-${k}`}
                  className={`pointer-events-none absolute top-0 z-20 h-full w-0.5 -translate-x-1/2 bg-[var(--color-primary)] ${k === "in" ? "rounded-l" : "rounded-r"}`}
                  style={{ left: pct(Math.min(marks[k] ?? 0, span)) }}
                />
              ),
            )}
          </>
        ) : null}
        <span
          aria-hidden
          className="pointer-events-none absolute top-0 z-20 h-full w-0.5 -translate-x-1/2 bg-[var(--color-fg)]"
          style={{ left: pct(Math.min(playhead, span)) }}
        />
        {box ? (
          // The marquee: what it touches is selected when the drag ends.
          <span
            aria-hidden
            data-testid="marquee"
            className="pointer-events-none absolute z-30 rounded-[2px] border border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_15%,transparent)]"
            style={{
              left: Math.min(box.x0, box.x1),
              top: Math.min(box.y0, box.y1),
              width: Math.abs(box.x1 - box.x0),
              height: Math.abs(box.y1 - box.y0),
            }}
          />
        ) : null}
        {guide !== null ? (
          // Where the trim has snapped to: held while the drag stays on the target.
          <span
            aria-hidden
            data-snap-guide=""
            className="pointer-events-none absolute top-0 z-30 h-full w-px -translate-x-1/2 bg-[var(--color-primary)] shadow-[0_0_0_1px_var(--color-primary)]"
            style={{ left: pct(Math.min(guide, span)) }}
          />
        ) : null}
      </div>
      <p id="editor-trim-keys" className="sr-only">
        {te.trimKeys}
      </p>
      <p id="editor-tool-keys" className="sr-only">
        {te.core.tools.keys}
      </p>
    </div>
  );
}

/**
 * The handles of the roll, slip and slide tools on the selected clip `index`: a roll has one at each cut the clip
 * has (its start, when a clip is before it; its end, when one is after it); a slip or a slide has one over the
 * clip. Each is a slider a keyboard can move (arrow = one frame, Shift + arrow = one second).
 */
function ToolHandles({
  tool,
  clips,
  index,
  src,
  onKey,
  onDown,
  onMove,
  onUp,
}: {
  tool: Exclude<EditTool, "trim">;
  clips: readonly VideoClip[];
  index: number;
  src: number | undefined;
  onKey: (e: KeyboardEvent<HTMLElement>, op: Omit<ToolOp, "delta">, speed: number, now: number) => void;
  onDown: (e: PointerEvent<HTMLElement>, op: Omit<ToolOp, "delta">, speed: number) => void;
  onMove: (e: PointerEvent<HTMLElement>) => void;
  onUp: () => void;
}) {
  const { t } = useI18n();
  const ct = t.editor.core.tools;
  const c = clips[index];
  const handle = (op: Omit<ToolOp, "delta">, speed: number, now: number) => ({
    role: "slider" as const,
    tabIndex: 0,
    "aria-describedby": "editor-tool-keys",
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => onKey(e, op, speed, now),
    onPointerDown: (e: PointerEvent<HTMLElement>) => onDown(e, op, speed),
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: onUp,
    "data-tool": op.tool,
  });
  const grip =
    "ns-trim-handle absolute top-0 z-10 flex h-full cursor-ew-resize touch-none items-center justify-center rounded-[var(--ns-r-chip)] bg-[var(--color-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-fg)]";
  if (tool === "roll") {
    const cuts: { id: string; a: number; side: "left-0" | "right-0"; at: number }[] = [];
    if (index > 0) cuts.push({ id: c.id, a: index, side: "left-0", at: clipEnd(clips[index - 1]) });
    if (index + 1 < clips.length) cuts.push({ id: clips[index + 1].id, a: index + 1, side: "right-0", at: clipEnd(c) });
    return (
      <>
        {cuts.map((k) => (
          <span
            key={k.id}
            {...handle({ tool, id: k.id }, 1, k.at)}
            aria-label={fmt(ct.rollHandle, { a: k.a, b: k.a + 1 })}
            aria-valuemin={0}
            aria-valuemax={pictureEnd(clips)}
            aria-valuenow={k.at}
            aria-valuetext={formatTime(k.at)}
            className={`${grip} ${k.side}`}
          >
            <span className="h-5 w-0.5 rounded-[1px] bg-[var(--color-on-accent)]" aria-hidden />
          </span>
        ))}
      </>
    );
  }
  const slip = tool === "slip";
  return (
    <span
      {...handle({ tool, id: c.id }, c.speed > 0 ? c.speed : 1, slip ? c.in_s : c.start_s)}
      aria-label={fmt(slip ? ct.slipHandle : ct.slideHandle, { n: index + 1 })}
      aria-valuenow={slip ? c.in_s : c.start_s}
      aria-valuemin={0}
      aria-valuemax={slip ? (src !== undefined ? Math.max(0, src - (c.out_s - c.in_s)) : undefined) : pictureEnd(clips)}
      aria-valuetext={formatTime(slip ? c.in_s : c.start_s)}
      className="absolute inset-x-2 inset-y-1 z-10 flex cursor-grab touch-none items-center justify-center rounded-[var(--ns-r-chip)] border border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_25%,transparent)] text-xs font-semibold text-[var(--color-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-fg)]"
    >
      <span aria-hidden>{slip ? "⇆" : "↔"}</span>
    </span>
  );
}

/** The end of the picture (the last clip's end). */
export function pictureEnd(clips: readonly VideoClip[]): number {
  return clips.reduce((e, c) => Math.max(e, clipEnd(c)), 0);
}
