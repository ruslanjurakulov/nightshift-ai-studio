"use client";

import { useEffect, useRef, useState } from "react";
import { addLayerNodes, type KonvaNS } from "@/components/imageEditor/scene";
import type { Layer } from "@/lib/imageEditor/layers";
import { fitView, type Rect, type Size, type View } from "@/lib/regionEdit/geometry";

/**
 * The picture on a Konva canvas (konva, MIT). The canvas only DRAWS and reports gestures; what a crop or a layer may be
 * is decided by lib/imageEditor (inside the picture, whole pixels, minimum sizes). It is not the only way in: every value
 * is also a plain field beside it and the focused canvas answers the keyboard, so nothing needs a pointer.
 * Konva is imported on the client after mount, never on the server.
 */
export type Tool = "crop" | "adjust" | "text" | "shapes" | "ai";

export type CanvasKey =
  | { type: "move"; dx: number; dy: number }
  | { type: "resize"; dx: number; dy: number }
  | { type: "cycle"; dir: 1 | -1 }
  | { type: "remove" };

export interface EditorCanvasProps {
  /** The coloured picture for the WHOLE canvas space, at `baseScale` of its size. */
  base: HTMLCanvasElement | null;
  /** The canvas space (source after mirror and turn). */
  canvas: Size;
  /** The part of the canvas that is shown: the crop, or all of it while cropping. */
  view: Rect;
  layers: readonly Layer[];
  selectedId: string | null;
  tool: Tool;
  /** The crop frame while the Crop tool is open. */
  crop: Rect;
  /** width / height the crop is locked to, or null. */
  ratio: number | null;
  label: string;
  keysId: string;
  onSelect: (id: string | null) => void;
  onMove: (id: string, cx: number, cy: number) => void;
  onBox: (id: string, w: number, h: number) => void;
  onCrop: (rect: Rect) => void;
  onKey: (action: CanvasKey) => void;
  onKeyEnd: () => void;
}

const MAX_HEIGHT_VH = 0.6;

export function EditorCanvas(props: EditorCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [ready, setReady] = useState(0);
  const kv = useRef<{ Konva: KonvaNS; stage: import("konva/lib/Stage").Stage; layer: import("konva/lib/Layer").Layer; size: Size } | null>(null);

  // Mount: create the stage and follow the container's width.
  useEffect(() => {
    let dead = false;
    let observer: ResizeObserver | null = null;
    (async () => {
      const Konva = (await import("konva")).default;
      const el = host.current;
      if (dead || !el) return;
      const stage = new Konva.Stage({ container: el, width: 10, height: 10 });
      const layer = new Konva.Layer();
      stage.add(layer);
      const state = { Konva, stage, layer, size: { width: 10, height: 10 } };
      kv.current = state;
      const layout = () => {
        const v = latest.current.view;
        const width = Math.max(160, Math.floor(el.clientWidth));
        const height = Math.max(120, Math.min(Math.round((width * v.h) / v.w), Math.round(window.innerHeight * MAX_HEIGHT_VH)));
        state.size = { width, height };
        stage.size({ width, height });
        setReady((n) => n + 1);
      };
      layout();
      observer = new ResizeObserver(layout);
      observer.observe(el);
    })();
    return () => {
      dead = true;
      observer?.disconnect();
      kv.current?.stage.destroy();
      kv.current = null;
    };
  }, []);

  // Redraw whenever anything the picture shows changes.
  const p = props;
  useEffect(() => {
    const k = kv.current;
    if (!k) return;
    const { Konva, stage, layer, size } = k;
    layer.destroyChildren();
    const accent = getComputedStyle(host.current as Element).getPropertyValue("--color-primary").trim() || "#f59e0b";
    const coarse = Boolean(window.matchMedia?.("(pointer: coarse)").matches);

    // The stage is sized for the CURRENT view; the view may have changed shape (crop tool <-> others).
    const height = Math.max(120, Math.min(Math.round((size.width * p.view.h) / p.view.w), Math.round(window.innerHeight * MAX_HEIGHT_VH)));
    if (height !== size.height) {
      k.size = { width: size.width, height };
      stage.size({ width: size.width, height });
    }
    const fit: View = fitView({ width: p.view.w, height: p.view.h }, { width: k.size.width, height: k.size.height });
    const s = fit.scale;
    // canvas px -> stage px: (x - view.x) * s + fit.ox
    const map = { scale: s, ox: fit.ox - p.view.x * s, oy: fit.oy - p.view.y * s };

    const content = new Konva.Group({ clip: { x: fit.ox, y: fit.oy, width: p.view.w * s, height: p.view.h * s } });
    layer.add(content);
    if (p.base) content.add(new Konva.Image({ image: p.base, x: map.ox, y: map.oy, width: p.canvas.width * s, height: p.canvas.height * s, listening: false }));

    const interactive = p.tool === "text" || p.tool === "shapes";
    const nodes = addLayerNodes(Konva, content, p.layers, map, {
      interactive,
      onSelect: (id) => latest.current.onSelect(id),
      onMove: (id, cx, cy) => latest.current.onMove(id, cx, cy),
    });

    // A selected layer: boxes get handles, text and lines a dashed outline.
    const picked = p.selectedId ? nodes.get(p.selectedId) : undefined;
    const pickedLayer = p.selectedId ? p.layers.find((l) => l.id === p.selectedId) : undefined;
    if (interactive && picked && pickedLayer) {
      if (pickedLayer.kind === "rect" || pickedLayer.kind === "ellipse") {
        const tr = new Konva.Transformer({
          nodes: [picked],
          rotateEnabled: false,
          flipEnabled: false,
          keepRatio: false,
          anchorSize: coarse ? 26 : 12,
          borderStroke: accent,
          anchorStroke: accent,
          anchorFill: "#fff",
        });
        content.add(tr);
        picked.on("transformend", () => {
          const w = (picked.width() * picked.scaleX()) / s;
          const h = (picked.height() * picked.scaleY()) / s;
          picked.scale({ x: 1, y: 1 });
          latest.current.onBox(pickedLayer.id, w, h);
        });
      } else {
        const box = picked.getClientRect();
        content.add(new Konva.Rect({ x: box.x - 3, y: box.y - 3, width: box.width + 6, height: box.height + 6, stroke: accent, dash: [5, 4], strokeWidth: 1.5, listening: false }));
      }
    }

    // The crop frame: dimmed outside, a draggable frame with handles (corners only when the shape is locked).
    if (p.tool === "crop") {
      const area = { x: map.ox, y: map.oy, w: p.canvas.width * s, h: p.canvas.height * s };
      const c = { x: p.crop.x * s + map.ox, y: p.crop.y * s + map.oy, w: p.crop.w * s, h: p.crop.h * s };
      const dim = { fill: "rgba(0,0,0,0.55)", listening: false } as const;
      const top = new Konva.Rect({ ...dim });
      const bottom = new Konva.Rect({ ...dim });
      const left = new Konva.Rect({ ...dim });
      const right = new Konva.Rect({ ...dim });
      content.add(top, bottom, left, right);
      const frame: import("konva/lib/shapes/Rect").Rect = new Konva.Rect({
        x: c.x, y: c.y, width: c.w, height: c.h,
        stroke: accent, strokeWidth: 2, strokeScaleEnabled: false,
        draggable: true,
        dragBoundFunc: (pos: { x: number; y: number }) => ({
          x: Math.max(area.x, Math.min(pos.x, area.x + area.w - frame.width() * frame.scaleX())),
          y: Math.max(area.y, Math.min(pos.y, area.y + area.h - frame.height() * frame.scaleY())),
        }),
      });
      const dimAround = () => {
        const x = frame.x();
        const y = frame.y();
        const w = frame.width() * frame.scaleX();
        const h = frame.height() * frame.scaleY();
        top.setAttrs({ x: area.x, y: area.y, width: area.w, height: Math.max(0, y - area.y) });
        bottom.setAttrs({ x: area.x, y: y + h, width: area.w, height: Math.max(0, area.y + area.h - (y + h)) });
        left.setAttrs({ x: area.x, y, width: Math.max(0, x - area.x), height: h });
        right.setAttrs({ x: x + w, y, width: Math.max(0, area.x + area.w - (x + w)), height: h });
      };
      dimAround();
      content.add(frame);
      const minPx = 16 * s;
      const tr = new Konva.Transformer({
        nodes: [frame],
        rotateEnabled: false,
        flipEnabled: false,
        keepRatio: p.ratio !== null,
        enabledAnchors: p.ratio === null ? undefined : ["top-left", "top-right", "bottom-left", "bottom-right"],
        anchorSize: coarse ? 26 : 12,
        borderStroke: accent,
        anchorStroke: accent,
        anchorFill: "#fff",
        boundBoxFunc: (old, box) => {
          if (box.width < minPx || box.height < minPx) return old;
          if (box.x < area.x - 0.5 || box.y < area.y - 0.5 || box.x + box.width > area.x + area.w + 0.5 || box.y + box.height > area.y + area.h + 0.5) return old;
          return box;
        },
      });
      content.add(tr);
      frame.on("dragmove transform", dimAround);
      const commit = () => {
        const rect = {
          x: (frame.x() - map.ox) / s,
          y: (frame.y() - map.oy) / s,
          w: (frame.width() * frame.scaleX()) / s,
          h: (frame.height() * frame.scaleY()) / s,
        };
        frame.scale({ x: 1, y: 1 });
        latest.current.onCrop({ x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) });
      };
      frame.on("dragend transformend", commit);
    }

    // Pressing on the picture itself (not on a layer) lets go of the selection.
    stage.off(".pick");
    stage.on("mousedown.pick touchstart.pick", (e) => {
      if (e.target === stage || e.target.getClassName() === "Image") latest.current.onSelect(null);
    });
    return () => {
      stage.off(".pick");
    };
  }, [p.base, p.canvas, p.view, p.layers, p.selectedId, p.tool, p.crop, p.ratio, ready]);

  const onKeyDown = (e: React.KeyboardEvent) => {
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
      onKeyUp={props.onKeyEnd}
      className="relative w-full select-none overflow-hidden rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel-2)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
      // While cropping or a layer is selected the canvas owns touch gestures; otherwise the page can still be scrolled past it.
      style={{ touchAction: props.tool === "crop" || props.selectedId ? "none" : "pan-y", minHeight: 120 }}
    />
  );
}

