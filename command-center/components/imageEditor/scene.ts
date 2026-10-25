import { FAMILY_CSS, type Layer } from "@/lib/imageEditor/layers";
import { canvasSize, outputSize, tooManyPixels, type EditState } from "@/lib/imageEditor/state";
import { fullRect } from "@/lib/imageEditor/crop";
import { JPEG_QUALITY, SAVE_MIME, type SaveFormat } from "@/lib/imageEditor/save";
import { renderBase } from "@/components/imageEditor/render";
import type { Size } from "@/lib/regionEdit/geometry";

/**
 * Text and shapes as Konva nodes. ONE function builds them for the on-screen preview and for the saved file, so the file
 * is what the person saw. Canvas space -> stage space is `x * scale + ox`. Konva is imported on the client after mount,
 * never on the server.
 */
export type KonvaNS = typeof import("konva").default;
type Group = import("konva/lib/Group").Group;
type Layer2 = import("konva/lib/Layer").Layer;
type Node = import("konva/lib/Shape").Shape;

export interface Mapping {
  scale: number;
  ox: number;
  oy: number;
}

export interface NodeHooks {
  /** Layers can be picked and dragged (the Text and Shapes tools). */
  interactive: boolean;
  onSelect: (id: string) => void;
  /** A drag ended: the new centre, in canvas pixels. */
  onMove: (id: string, cx: number, cy: number) => void;
}

export function addLayerNodes(Konva: KonvaNS, parent: Group | Layer2, layers: readonly Layer[], map: Mapping, hooks?: NodeHooks): Map<string, Node> {
  const nodes = new Map<string, Node>();
  for (const l of layers) {
    const x = l.cx * map.scale + map.ox;
    const y = l.cy * map.scale + map.oy;
    let node: Node;
    if (l.kind === "text") {
      const t = new Konva.Text({
        x,
        y,
        text: l.text || " ",
        fontSize: l.fontSize * map.scale,
        fontFamily: FAMILY_CSS[l.family],
        fontStyle: l.bold ? "bold" : "normal",
        fill: l.color,
        align: "center",
        lineHeight: 1.15,
      });
      // Centre-anchored, so a turn or a flip needs no text measuring.
      t.offsetX(t.width() / 2);
      t.offsetY(t.height() / 2);
      node = t;
    } else if (l.kind === "line") {
      node = new Konva.Line({
        x,
        y,
        points: [-l.dx * map.scale, -l.dy * map.scale, l.dx * map.scale, l.dy * map.scale],
        stroke: l.color,
        strokeWidth: l.strokeWidth * map.scale,
        lineCap: "round",
        hitStrokeWidth: Math.max(l.strokeWidth * map.scale, 24),
      });
    } else if (l.kind === "ellipse") {
      node = new Konva.Ellipse({
        x,
        y,
        radiusX: (l.w / 2) * map.scale,
        radiusY: (l.h / 2) * map.scale,
        ...(l.filled ? { fill: l.color } : { stroke: l.color, strokeWidth: l.strokeWidth * map.scale }),
      });
    } else {
      node = new Konva.Rect({
        x,
        y,
        width: l.w * map.scale,
        height: l.h * map.scale,
        offsetX: (l.w * map.scale) / 2,
        offsetY: (l.h * map.scale) / 2,
        ...(l.filled ? { fill: l.color } : { stroke: l.color, strokeWidth: l.strokeWidth * map.scale }),
      });
    }
    node.id(l.id);
    if (hooks) {
      node.listening(hooks.interactive);
      if (hooks.interactive) {
        node.draggable(true);
        node.on("mousedown touchstart", () => hooks.onSelect(l.id));
        node.on("dragend", () => hooks.onMove(l.id, (node.x() - map.ox) / map.scale, (node.y() - map.oy) / map.scale));
      }
    }
    parent.add(node);
    nodes.set(l.id, node);
  }
  return nodes;
}

/**
 * The finished picture: the crop window of the coloured picture with the layers over it, at the crop's own pixel size
 * (scale 1, pixel ratio 1). Rejects when the browser cannot build or encode a canvas that size.
 */
export async function exportPicture(
  Konva: KonvaNS,
  img: CanvasImageSource,
  src: Size,
  state: EditState,
  format: SaveFormat,
): Promise<Blob> {
  const out = outputSize(src, state);
  if (tooManyPixels(out)) throw new Error("too_many_pixels");
  const area = state.crop ?? fullRect(canvasSize(src, state.rotation));
  const base = renderBase(img, src, state, area, 1, format === "jpeg");
  if (!base) throw new Error("no_canvas");
  const holder = document.createElement("div");
  const stage = new Konva.Stage({ container: holder, width: out.width, height: out.height });
  try {
    const layer = new Konva.Layer({ listening: false });
    // A Konva layer sizes its canvas by window.devicePixelRatio (3 on a phone): a 4000 x 3000 file would need a 12000 x 9000
    // canvas, which iOS Safari (16.7 MP) refuses and a desktop at 2 wastes hundreds of MB on. The file is made at exactly its own
    // size, so the ratio is fixed to 1 BEFORE the stage sizes the layer. toBlob re-renders from the nodes, so no draw() here.
    layer.getCanvas().setPixelRatio(1);
    layer.getHitCanvas().setPixelRatio(1);
    stage.add(layer);
    layer.add(new Konva.Image({ image: base, x: 0, y: 0, width: out.width, height: out.height }));
    addLayerNodes(Konva, layer, state.layers, { scale: 1, ox: -area.x, oy: -area.y });
    const blob = await stage.toBlob({ mimeType: SAVE_MIME[format], quality: format === "jpeg" ? JPEG_QUALITY : undefined, pixelRatio: 1 });
    if (!blob || blob.size <= 0) throw new Error("empty");
    return blob;
  } finally {
    stage.destroy();
  }
}
