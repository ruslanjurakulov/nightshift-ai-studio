"use client";

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import {
  clipEnd,
  clipLength,
  formatTime,
  type EditorAsset,
  type TextClip,
  type VideoClip,
} from "@/lib/editor";

export type Selection = { kind: "clip" | "text"; id: string } | null;

/** Lanes so texts that share time sit one above the other, not on top of each other. */
export function textLanes(texts: readonly TextClip[]): Map<string, number> {
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
 * The timeline: the picture's clips end to end, the texts under them, and the
 * playhead. A selected clip gets two trim handles — sliders a keyboard can
 * move (arrow = one frame, Shift + arrow = one second, Home / End = as far as
 * the source allows) and a pointer can drag. The strip only reports changes;
 * the editor decides (and the model clamps them).
 */
export function TimelineStrip({
  clips,
  texts,
  total,
  fps,
  playhead,
  selected,
  assets,
  onSelect,
  onTrim,
  onTrimEnd,
}: {
  clips: readonly VideoClip[];
  texts: readonly TextClip[];
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
  } | null>(null);
  const span = Math.max(total, 0.001);
  const pct = (s: number) => `${(Math.max(0, s) / span) * 100}%`;
  const lanes = textLanes(texts);
  const laneCount = Math.max(1, ...[...lanes.values()].map((l) => l + 1));
  const frame = 1 / fps;

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
    };
  }

  function onHandleMove(e: PointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d) return;
    // Pixels are timeline seconds; a trim moves SOURCE seconds (× speed).
    const value = d.v0 + ((e.clientX - d.x0) / d.pxPerS) * d.speed;
    onTrim(d.id, d.edge, Math.round(value * fps) / fps, false);
  }

  function onHandleUp() {
    if (!drag.current) return;
    drag.current = null;
    onTrimEnd();
  }

  return (
    <div className="overflow-x-auto pb-1" role="group" aria-label={te.timeline}>
      <div
        ref={strip}
        className="relative flex flex-col gap-1.5"
        style={{ minWidth: `max(100%, ${clips.length * 44}px)` }}
      >
        <div
          className="flex h-14 w-full"
          aria-label={te.clipsTrack}
          role="list"
        >
          {clips.map((c, i) => {
            const len = clipLength(c);
            const on = selected?.kind === "clip" && selected.id === c.id;
            const name = assets[c.asset_id]?.name ?? te.untitledVideo;
            const src = assets[c.asset_id]?.durationS ?? undefined;
            return (
              <div
                key={c.id}
                role="listitem"
                className="relative h-full shrink-0 px-px"
                style={{ width: pct(len) }}
              >
                <button
                  type="button"
                  onClick={() => onSelect({ kind: "clip", id: c.id })}
                  aria-pressed={on}
                  aria-label={fmt(te.clipLabel, {
                    n: i + 1,
                    name,
                    length: formatTime(len),
                  })}
                  className={`flex size-full min-w-0 flex-col justify-between overflow-hidden rounded-lg border px-1.5 py-1 text-left text-[11px] ${
                    on
                      ? "border-[var(--color-primary)] bg-[var(--color-accent-soft)] text-[var(--color-fg)]"
                      : "border-[var(--color-border)] bg-[var(--color-panel-2)] text-[var(--color-muted)]"
                  }`}
                >
                  <span className="truncate">{name}</span>
                  {c.speed !== 1 ? (
                    <span className="font-semibold text-[var(--color-primary)]">
                      {fmt(te.speedValue, { x: c.speed })}
                    </span>
                  ) : null}
                </button>
                {on ? (
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
                        className={`absolute top-0 z-10 flex h-full w-3 cursor-ew-resize touch-none items-center justify-center rounded-md bg-[var(--color-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-fg)] ${
                          edge === "in" ? "left-0" : "right-0"
                        }`}
                      >
                        <span
                          className="h-5 w-0.5 rounded bg-[var(--color-on-accent)]"
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
        <div
          className="relative w-full"
          style={{ height: `${laneCount * 30}px` }}
          aria-label={te.textTrack}
          role="list"
        >
          {texts.map((x) => {
            const on = selected?.kind === "text" && selected.id === x.id;
            return (
              <div
                key={x.id}
                role="listitem"
                className="absolute h-7"
                style={{
                  left: pct(x.start_s),
                  width: pct(x.end_s - x.start_s),
                  top: `${(lanes.get(x.id) ?? 0) * 30}px`,
                }}
              >
                <button
                  type="button"
                  onClick={() => onSelect({ kind: "text", id: x.id })}
                  aria-pressed={on}
                  aria-label={fmt(te.textClipLabel, {
                    text: x.text || "…",
                    from: formatTime(x.start_s),
                    to: formatTime(x.end_s),
                  })}
                  className={`size-full truncate rounded-md border px-1.5 text-left text-[11px] ${
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
        <span
          aria-hidden
          className="pointer-events-none absolute top-0 z-20 h-full w-0.5 -translate-x-1/2 bg-[var(--color-fg)]"
          style={{ left: pct(Math.min(playhead, span)) }}
        />
      </div>
      <p id="editor-trim-keys" className="sr-only">
        {te.trimKeys}
      </p>
    </div>
  );
}

/** The end of the picture (the last clip's end). */
export function pictureEnd(clips: readonly VideoClip[]): number {
  return clips.reduce((e, c) => Math.max(e, clipEnd(c)), 0);
}
