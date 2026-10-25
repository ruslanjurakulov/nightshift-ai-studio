"use client";

import { useEffect, useRef, useState } from "react";
import {
  clampPoint,
  fitView,
  rectFromCorners,
  toCanvasRect,
  toImagePoint,
  toImageRect,
  type EditorRegion,
  type Rect,
  type Size,
  type View,
} from "@/lib/regionEdit/geometry";

/**
 * The picture with its regions, drawn on a Konva canvas (konva, MIT). The canvas only DRAWS and reports gestures;
 * what a rectangle may be is decided by lib/regionEdit/geometry (inside the picture, at least 16 px, whole pixels).
 * It is not the only way in: the same regions are plain fields in the list beside it and the focused canvas answers
 * the keyboard, so nothing needs a pointer. Konva is imported on the client after mount, never on the server.
 */
export interface RegionCanvasProps {
  imageUrl: string;
  imageSize: Size;
  regions: readonly EditorRegion[];
  selectedId: string | null;
  /** Dragging on the empty picture draws a new region. */
  drawing: boolean;
  disabled: boolean;
  label: string;
  keysId: string;
  onSelect: (id: string | null) => void;
  onChange: (id: string, rect: Rect) => void;
  onDraw: (rect: Rect) => void;
  onKey: (action: { type: "move" | "resize"; dx: number; dy: number } | { type: "cycle"; dir: 1 | -1 } | { type: "remove" }) => void;
  onImageError: () => void;
}

type KonvaModule = typeof import("konva").default;

const MAX_HEIGHT_VH = 0.6;

export function RegionCanvas(props: RegionCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [ready, setReady] = useState(0);
  const kv = useRef<{
    Konva: KonvaModule;
    stage: import("konva/lib/Stage").Stage;
    bg: import("konva/lib/Layer").Layer;
    fg: import("konva/lib/Layer").Layer;
    view: View;
    img: HTMLImageElement | null;
  } | null>(null);

  // Mount: create the stage, follow the container's width, load the picture.
  useEffect(() => {
    let dead = false;
    let observer: ResizeObserver | null = null;
    (async () => {
      const Konva = (await import("konva")).default;
      const el = host.current;
      if (dead || !el) return;
      const stage = new Konva.Stage({ container: el, width: 10, height: 10 });
      const bg = new Konva.Layer({ listening: true });
      const fg = new Konva.Layer();
      stage.add(bg);
      stage.add(fg);
      const state = { Konva, stage, bg, fg, view: { scale: 1, ox: 0, oy: 0 } as View, img: null as HTMLImageElement | null };
      kv.current = state;
      const layout = () => {
        const p = latest.current;
        const width = Math.max(160, Math.floor(el.clientWidth));
        const height = Math.max(120, Math.min(Math.round((width * p.imageSize.height) / p.imageSize.width), Math.round(window.innerHeight * MAX_HEIGHT_VH)));
        stage.size({ width, height });
        state.view = fitView(p.imageSize, { width, height });
        setReady((n) => n + 1);
      };
      layout();
      observer = new ResizeObserver(layout);
      observer.observe(el);
      const img = new window.Image();
      img.onload = () => {
        if (dead) return;
        state.img = img;
        setReady((n) => n + 1);
      };
      img.onerror = () => {
        if (!dead) latest.current.onImageError();
      };
      img.src = latest.current.imageUrl;
    })();
    return () => {
      dead = true;
      observer?.disconnect();
      kv.current?.stage.destroy();
      kv.current = null;
    };
    // The picture is fixed for the life of this canvas: the parent remounts it (key) for another one.
  }, []);

  // Redraw whenever the regions, the selection, the mode or the size change.
  useEffect(() => {
    const k = kv.current;
    if (!k || !k.img) return;
    const { Konva, stage, bg, fg, view, img } = k;
    const p = props;
    const accent = getComputedStyle(host.current as Element).getPropertyValue("--color-primary").trim() || "#f59e0b";
    bg.destroyChildren();
    fg.destroyChildren();
    const image = new Konva.Image({ image: img, x: view.ox, y: view.oy, width: p.imageSize.width * view.scale, height: p.imageSize.height * view.scale });
    bg.add(image);

    const bounds = p.imageSize;
    const area = { x: view.ox, y: view.oy, w: bounds.width * view.scale, h: bounds.height * view.scale };
    let selectedNode: import("konva/lib/shapes/Rect").Rect | null = null;
    for (const r of p.regions) {
      const c = toCanvasRect(r, view);
      const selected = r.id === p.selectedId;
      const rect = new Konva.Rect({
        x: c.x, y: c.y, width: c.w, height: c.h,
        stroke: accent, strokeWidth: selected ? 3 : 2, strokeScaleEnabled: false,
        fill: selected ? "rgba(245,158,11,0.18)" : "rgba(245,158,11,0.08)",
        draggable: selected && !p.disabled && !p.drawing,
        // The size at the moment the drag starts: a Transformer's scale is folded back into width/height on release.
        dragBoundFunc: (pos: { x: number; y: number }) => ({
          x: Math.max(area.x, Math.min(pos.x, area.x + area.w - c.w)),
          y: Math.max(area.y, Math.min(pos.y, area.y + area.h - c.h)),
        }),
      });
      rect.on("mousedown touchstart", (e: import("konva/lib/Node").KonvaEventObject<Event>) => {
        e.cancelBubble = true;
        if (!p.drawing) latest.current.onSelect(r.id);
      });
      const commit = () => {
        const next = toImageRect({ x: rect.x(), y: rect.y(), w: rect.width() * rect.scaleX(), h: rect.height() * rect.scaleY() }, view, bounds);
        rect.scale({ x: 1, y: 1 });
        latest.current.onChange(r.id, next);
      };
      rect.on("dragend", commit);
      rect.on("transformend", commit);
      fg.add(rect);
      const tag = new Konva.Text({ x: c.x + 4, y: c.y + 3, text: r.name, fontSize: 12, fill: "#fff", listening: false, shadowColor: "#000", shadowBlur: 3, shadowOpacity: 0.9 });
      fg.add(tag);
      if (selected) selectedNode = rect;
    }
    if (selectedNode && !p.disabled && !p.drawing) {
      const coarse = window.matchMedia?.("(pointer: coarse)").matches;
      const tr = new Konva.Transformer({
        nodes: [selectedNode], rotateEnabled: false, keepRatio: false, flipEnabled: false,
        anchorSize: coarse ? 26 : 12, borderStroke: accent, anchorStroke: accent, anchorFill: "#fff",
        boundBoxFunc: (_old, box) => {
          const minPx = 16 * view.scale;
          if (box.width < minPx || box.height < minPx) return _old;
          const x = Math.max(area.x, Math.min(box.x, area.x + area.w - minPx));
          const y = Math.max(area.y, Math.min(box.y, area.y + area.h - minPx));
          return { ...box, x, y, width: Math.min(box.width, area.x + area.w - x), height: Math.min(box.height, area.y + area.h - y) };
        },
      });
      fg.add(tr);
    }

    // Drawing a new region: drag on the picture (not on a region).
    let start: { x: number; y: number } | null = null;
    let ghost: import("konva/lib/shapes/Rect").Rect | null = null;
    const point = () => {
      const pos = stage.getPointerPosition();
      return pos ? toImagePoint(pos, view, bounds) : null;
    };
    stage.off(".draw");
    stage.on("mousedown.draw touchstart.draw", () => {
      if (p.disabled) return;
      if (!p.drawing) {
        latest.current.onSelect(null);
        return;
      }
      start = point();
      if (start) {
        ghost = new Konva.Rect({ stroke: accent, dash: [6, 4], strokeWidth: 2, strokeScaleEnabled: false, listening: false });
        fg.add(ghost);
      }
    });
    stage.on("mousemove.draw touchmove.draw", () => {
      const now = point();
      if (!start || !ghost || !now) return;
      const a = toCanvasRect(rectFromCorners(start, clampPoint(now, bounds), bounds), view);
      ghost.setAttrs({ x: a.x, y: a.y, width: a.w, height: a.h });
    });
    stage.on("mouseup.draw touchend.draw", () => {
      const now = point();
      const from = start;
      start = null;
      ghost?.destroy();
      ghost = null;
      if (from && now) latest.current.onDraw(rectFromCorners(from, now, bounds));
    });
    return () => {
      stage.off(".draw");
    };
  }, [props.regions, props.selectedId, props.drawing, props.disabled, props.imageSize, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (props.disabled) return;
    const step = e.shiftKey ? 10 : 1;
    const dir: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = dir[e.key];
    if (d) {
      e.preventDefault();
      props.onKey({ type: e.altKey ? "resize" : "move", dx: d[0], dy: d[1] });
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      props.onKey({ type: "cycle", dir: e.key === "PageDown" ? 1 : -1 });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      props.onKey({ type: "remove" });
    }
  };

  return (
    <div
      ref={host}
      role="group"
      tabIndex={0}
      aria-label={props.label}
      aria-describedby={props.keysId}
      onKeyDown={onKeyDown}
      className="relative w-full select-none overflow-hidden rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel-2)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
      // While drawing or a region is selected the canvas owns touch gestures; otherwise the page can still be scrolled past it.
      style={{ touchAction: props.drawing || props.selectedId ? "none" : "pan-y", minHeight: 120 }}
    />
  );
}
