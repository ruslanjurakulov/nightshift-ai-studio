"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { SoundWave } from "./SoundWave";
import { Timecode } from "@/components/ui/Timecode";
import {
  clipEnd,
  clipLength,
  crossfadeOf,
  formatTime,
  soundLength,
  type EditorAsset,
  type SoundClip,
  type TextClip,
  type VideoClip,
} from "@/lib/editor";

export type Selection = { kind: "clip" | "text" | "sound"; id: string } | null;

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
                className="absolute top-0 whitespace-nowrap pl-1 text-[10px] leading-[12px] text-[var(--color-muted)]"
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
          {clips.map((c, i) => {
            const len = clipLength(c);
            const on = selected?.kind === "clip" && selected.id === c.id;
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
                  onClick={() => onSelect({ kind: "clip", id: c.id })}
                  aria-pressed={on}
                  aria-label={
                    x > 0
                      ? `${label}, ${fmt(te.clipCrossfade, { s: x })}`
                      : label
                  }
                  className={`relative flex size-full min-w-0 flex-col justify-between overflow-hidden rounded-[var(--ns-r-key)] border px-1.5 py-1 text-left text-[11px] ${
                    on
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
                        className={`absolute top-0 z-10 flex h-full w-3 cursor-ew-resize touch-none items-center justify-center rounded-[var(--ns-r-chip)] bg-[var(--color-primary)] outline-none after:absolute after:inset-y-0 after:-inset-x-4 after:content-[''] focus-visible:ring-2 focus-visible:ring-[var(--color-fg)] ${
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
        {sounds.length ? (
          <div
            className="relative w-full"
            style={{ height: `${sLaneCount * 30}px` }}
            aria-label={te.soundsTrack}
            role="list"
          >
            {sounds.map((x) => {
              const on = selected?.kind === "sound" && selected.id === x.id;
              const end = x.start_s + soundLength(x);
              const name = assets[x.asset_id]?.name ?? te.untitledSound;
              return (
                <div
                  key={x.id}
                  role="listitem"
                  className="absolute h-7"
                  style={{
                    left: pct(x.start_s),
                    width: pct(end - x.start_s),
                    top: `${(sLanes.get(x.id) ?? 0) * 30}px`,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onSelect({ kind: "sound", id: x.id })}
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
                    className={`relative size-full overflow-hidden truncate rounded-[var(--ns-r-chip)] border px-1.5 text-left text-[11px] ${
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
                  className={`size-full truncate rounded-[var(--ns-r-chip)] border px-1.5 text-left text-[11px] ${
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
