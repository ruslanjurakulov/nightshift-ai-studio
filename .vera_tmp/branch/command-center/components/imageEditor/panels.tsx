"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { NumField } from "@/components/imageEditor/NumField";
import { ADJUST_KEYS, ADJUST_MAX, ADJUST_MIN, type Adjust, type AdjustKey } from "@/lib/imageEditor/adjust";
import { ASPECTS, MIN_CROP_PX, type AspectId } from "@/lib/imageEditor/crop";
import {
  FAMILIES,
  FONT_MAX,
  FONT_MIN,
  MAX_LAYERS,
  STROKE_MAX,
  STROKE_MIN,
  SWATCHES,
  lineFromPolar,
  lineToPolar,
  normalizeColor,
  type Layer,
  type LayerPatch,
  type ShapeKind,
} from "@/lib/imageEditor/layers";
import type { Rect, Size } from "@/lib/regionEdit/geometry";

/** The side panels of the image editor: each is a plain form over the same state the canvas draws. */

export const AI_TOOLS = ["upscale", "remove_bg", "expand", "relight", "erase"] as const;

/** The name a layer goes by in lists and announcements. */
export function useLayerName() {
  const { t, fmt } = useI18n();
  const e = t.imageEditor;
  return (layers: readonly Layer[], l: Layer): string => {
    if (l.kind === "text") return fmt(e.layerText, { text: l.text.replace(/\s+/g, " ").trim().slice(0, 24) || "…" });
    const n = layers.filter((x) => x.kind === l.kind).findIndex((x) => x.id === l.id) + 1;
    return fmt(l.kind === "rect" ? e.layerRect : l.kind === "ellipse" ? e.layerEllipse : e.layerLine, { n });
  };
}

export function CropPanel({
  crop,
  canvas,
  aspect,
  onAspect,
  onField,
  onEnd,
  onReset,
  hasCrop,
  onRotateLeft,
  onRotateRight,
  onFlipH,
  onFlipV,
}: {
  crop: Rect;
  canvas: Size;
  aspect: AspectId;
  onAspect: (a: AspectId) => void;
  onField: (field: "x" | "y" | "w" | "h", n: number) => void;
  onEnd: () => void;
  onReset: () => void;
  hasCrop: boolean;
  onRotateLeft: () => void;
  onRotateRight: () => void;
  onFlipH: () => void;
  onFlipV: () => void;
}) {
  const { t, fmt } = useI18n();
  const e = t.imageEditor;
  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="ie-turn" className="flex flex-col gap-2">
        <h3 id="ie-turn" className="t-panel">{e.turnTitle}</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <button type="button" className="btn-quiet" onClick={onRotateLeft}>{e.rotateLeft}</button>
          <button type="button" className="btn-quiet" onClick={onRotateRight}>{e.rotateRight}</button>
          <button type="button" className="btn-quiet" onClick={onFlipH}>{e.flipH}</button>
          <button type="button" className="btn-quiet" onClick={onFlipV}>{e.flipV}</button>
        </div>
      </section>
      <section aria-labelledby="ie-crop" className="flex flex-col gap-3">
        <h3 id="ie-crop" className="t-panel">{e.cropTitle}</h3>
        <p className="text-sm text-[var(--color-muted)]">{e.cropHint}</p>
        <div role="group" aria-label={e.aspectLabel} className="flex flex-wrap gap-2">
          {ASPECTS.map((a) => (
            <button key={a} type="button" className={aspect === a ? "btn-primary" : "btn-quiet"} aria-pressed={aspect === a} onClick={() => onAspect(a)}>
              {e.aspects[a]}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <NumField id="ie-crop-x" label={e.cropX} value={crop.x} min={0} max={canvas.width - MIN_CROP_PX} onCommit={(n) => onField("x", n)} onEnd={onEnd} />
          <NumField id="ie-crop-y" label={e.cropY} value={crop.y} min={0} max={canvas.height - MIN_CROP_PX} onCommit={(n) => onField("y", n)} onEnd={onEnd} />
          <NumField id="ie-crop-w" label={e.cropW} value={crop.w} min={MIN_CROP_PX} max={canvas.width} onCommit={(n) => onField("w", n)} onEnd={onEnd} />
          <NumField id="ie-crop-h" label={e.cropH} value={crop.h} min={MIN_CROP_PX} max={canvas.height} onCommit={(n) => onField("h", n)} onEnd={onEnd} />
        </div>
        <p className="text-sm text-[var(--color-muted)]" aria-live="polite">{fmt(e.cropSize, { w: crop.w, h: crop.h })}</p>
        <div>
          <button type="button" className="btn-quiet" disabled={!hasCrop} onClick={onReset}>{e.cropReset}</button>
        </div>
      </section>
    </div>
  );
}

export function AdjustPanel({
  adjust,
  onChange,
  onEnd,
  onReset,
}: {
  adjust: Adjust;
  onChange: (key: AdjustKey, value: number) => void;
  onEnd: () => void;
  onReset: () => void;
}) {
  const { t } = useI18n();
  const e = t.imageEditor;
  const neutral = ADJUST_KEYS.every((k) => adjust[k] === 0);
  return (
    <section aria-labelledby="ie-adjust" className="flex flex-col gap-3">
      <h3 id="ie-adjust" className="t-panel">{e.adjustTitle}</h3>
      <p className="text-sm text-[var(--color-muted)]">{e.adjustHint}</p>
      {ADJUST_KEYS.map((k) => (
        <div key={k} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={`ie-adj-${k}`} className="studio-label">{e[k]}</label>
            <span className="text-sm tabular-nums text-[var(--color-muted)]">{adjust[k]}</span>
          </div>
          <input
            id={`ie-adj-${k}`}
            type="range"
            min={ADJUST_MIN}
            max={ADJUST_MAX}
            step={1}
            value={adjust[k]}
            onChange={(ev) => onChange(k, Number(ev.target.value))}
            onPointerUp={onEnd}
            onKeyUp={onEnd}
            onBlur={onEnd}
            className="h-11 w-full"
          />
        </div>
      ))}
      <div>
        <button type="button" className="btn-quiet" disabled={neutral} onClick={onReset}>{e.adjustReset}</button>
      </div>
    </section>
  );
}

function ColorField({ id, value, onChange, onEnd }: { id: string; value: string; onChange: (hex: string) => void; onEnd: () => void }) {
  const { t, fmt } = useI18n();
  const e = t.imageEditor;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="studio-label">{e.color}</label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={id}
          type="color"
          value={normalizeColor(value)}
          onChange={(ev) => onChange(ev.target.value)}
          onBlur={onEnd}
          className="h-11 w-14 cursor-pointer rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-transparent p-1"
        />
        {SWATCHES.map((hex) => (
          <button
            key={hex}
            type="button"
            aria-label={fmt(e.swatch, { hex })}
            aria-pressed={normalizeColor(value) === hex}
            onClick={() => {
              onChange(hex);
              onEnd();
            }}
            className="size-11 rounded-full border-2 border-[var(--color-border)] aria-pressed:border-[var(--color-primary)]"
            style={{ background: hex }}
          />
        ))}
      </div>
    </div>
  );
}

export function LayerPanel({
  mode,
  layers,
  selectedId,
  canvas,
  onAdd,
  onSelect,
  onRemove,
  onPatch,
  onEnd,
}: {
  mode: "text" | "shapes";
  layers: readonly Layer[];
  selectedId: string | null;
  canvas: Size;
  onAdd: (kind: "text" | ShapeKind) => void;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onPatch: (id: string, patch: LayerPatch, key: string) => void;
  onEnd: () => void;
}) {
  const { t, fmt } = useI18n();
  const e = t.imageEditor;
  const nameOf = useLayerName();
  const mine = layers.filter((l) => (mode === "text" ? l.kind === "text" : l.kind !== "text"));
  const picked = mine.find((l) => l.id === selectedId) ?? null;
  const full = layers.length >= MAX_LAYERS;
  const heading = mode === "text" ? e.textTitle : e.shapesTitle;
  return (
    <section aria-labelledby={`ie-layers-${mode}`} className="flex flex-col gap-3">
      <h3 id={`ie-layers-${mode}`} className="t-panel">{heading}</h3>
      <div className="flex flex-wrap gap-2">
        {mode === "text" ? (
          <button type="button" className="btn-primary" disabled={full} onClick={() => onAdd("text")}>{e.addText}</button>
        ) : (
          <>
            <button type="button" className="btn-primary" disabled={full} onClick={() => onAdd("rect")}>{e.addRect}</button>
            <button type="button" className="btn-primary" disabled={full} onClick={() => onAdd("ellipse")}>{e.addEllipse}</button>
            <button type="button" className="btn-primary" disabled={full} onClick={() => onAdd("line")}>{e.addLine}</button>
          </>
        )}
      </div>
      {full ? <p className="text-xs text-[var(--color-muted)]">{fmt(e.layerLimit, { max: MAX_LAYERS })}</p> : null}
      {mine.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">{mode === "text" ? e.noText : e.noShapes}</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={e.layersTitle}>
          {mine.map((l) => (
            <li key={l.id} className="flex items-center gap-2">
              <button
                type="button"
                className={l.id === selectedId ? "btn-primary min-w-0 flex-1 justify-start" : "btn-quiet min-w-0 flex-1 justify-start"}
                aria-pressed={l.id === selectedId}
                aria-label={fmt(e.selectLayer, { name: nameOf(layers, l) })}
                onClick={() => onSelect(l.id)}
              >
                <span className="truncate">{nameOf(layers, l)}</span>
              </button>
              <button type="button" className="btn-quiet" aria-label={fmt(e.removeLayer, { name: nameOf(layers, l) })} onClick={() => onRemove(l.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {picked ? <LayerFields layer={picked} canvas={canvas} onPatch={onPatch} onEnd={onEnd} /> : null}
    </section>
  );
}

function LayerFields({ layer, canvas, onPatch, onEnd }: { layer: Layer; canvas: Size; onPatch: (id: string, patch: LayerPatch, key: string) => void; onEnd: () => void }) {
  const { t } = useI18n();
  const e = t.imageEditor;
  const id = layer.id;
  const patch = (p: LayerPatch, key: string) => onPatch(id, p, `${key}:${id}`);
  const position = (
    <div className="grid grid-cols-2 gap-3">
      <NumField id={`ie-${id}-x`} label={e.posX} value={layer.cx} min={0} max={canvas.width} onCommit={(n) => patch({ cx: n }, "x")} onEnd={onEnd} />
      <NumField id={`ie-${id}-y`} label={e.posY} value={layer.cy} min={0} max={canvas.height} onCommit={(n) => patch({ cy: n }, "y")} onEnd={onEnd} />
    </div>
  );
  if (layer.kind === "text") {
    return (
      <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={`ie-${id}-text`} className="studio-label">{e.textLabel}</label>
          <div className="studio-field">
            <textarea
              id={`ie-${id}-text`}
              value={layer.text}
              rows={2}
              maxLength={200}
              onChange={(ev) => patch({ text: ev.target.value }, "text")}
              onBlur={onEnd}
              className="min-h-11 w-full resize-y bg-transparent px-3 py-2 text-base text-[var(--color-fg)] outline-none sm:text-[14px]"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <NumField id={`ie-${id}-size`} label={e.fontSize} value={layer.fontSize} min={FONT_MIN} max={FONT_MAX} onCommit={(n) => patch({ fontSize: n }, "size")} onEnd={onEnd} />
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={`ie-${id}-font`} className="studio-label">{e.font}</label>
            <div className="studio-field">
              <select
                id={`ie-${id}-font`}
                value={layer.family}
                onChange={(ev) => {
                  patch({ family: ev.target.value as (typeof FAMILIES)[number] }, "font");
                  onEnd();
                }}
                className="min-h-11 w-full bg-transparent px-3 text-base text-[var(--color-fg)] outline-none sm:text-[14px]"
              >
                {FAMILIES.map((f) => (
                  <option key={f} value={f}>{e.fonts[f]}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={layer.bold}
            onChange={(ev) => {
              patch({ bold: ev.target.checked }, "bold");
              onEnd();
            }}
            className="size-5"
          />
          {e.bold}
        </label>
        <ColorField id={`ie-${id}-color`} value={layer.color} onChange={(hex) => patch({ color: hex }, "color")} onEnd={onEnd} />
        {position}
      </div>
    );
  }
  const stroke = (
    <NumField id={`ie-${id}-stroke`} label={e.strokeWidth} value={layer.strokeWidth} min={STROKE_MIN} max={STROKE_MAX} onCommit={(n) => patch({ strokeWidth: n }, "stroke")} onEnd={onEnd} />
  );
  if (layer.kind === "line") {
    const polar = lineToPolar(layer);
    const setPolar = (length: number, angle: number) => patch(lineFromPolar(length, angle), "line");
    return (
      <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-3">
        <div className="grid grid-cols-2 gap-3">
          <NumField id={`ie-${id}-len`} label={e.lineLength} value={polar.length} min={1} max={Math.max(canvas.width, canvas.height) * 2} onCommit={(n) => setPolar(n, polar.angle)} onEnd={onEnd} />
          <NumField id={`ie-${id}-ang`} label={e.lineAngle} value={polar.angle} min={0} max={359} onCommit={(n) => setPolar(polar.length, n)} onEnd={onEnd} />
        </div>
        {stroke}
        <ColorField id={`ie-${id}-color`} value={layer.color} onChange={(hex) => patch({ color: hex }, "color")} onEnd={onEnd} />
        {position}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-3">
      <div className="grid grid-cols-2 gap-3">
        <NumField id={`ie-${id}-w`} label={e.shapeW} value={layer.w} min={4} max={canvas.width * 2} onCommit={(n) => patch({ w: n }, "w")} onEnd={onEnd} />
        <NumField id={`ie-${id}-h`} label={e.shapeH} value={layer.h} min={4} max={canvas.height * 2} onCommit={(n) => patch({ h: n }, "h")} onEnd={onEnd} />
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={layer.filled}
          onChange={(ev) => {
            patch({ filled: ev.target.checked }, "filled");
            onEnd();
          }}
          className="size-5"
        />
        {e.filled}
      </label>
      {stroke}
      <ColorField id={`ie-${id}-color`} value={layer.color} onChange={(hex) => patch({ color: hex }, "color")} onEnd={onEnd} />
      {position}
    </div>
  );
}

export function AiPanel({ assetId, path }: { assetId: string; path: (section: string) => string }) {
  const { t } = useI18n();
  const e = t.imageEditor;
  return (
    <section aria-labelledby="ie-ai" className="flex flex-col gap-3">
      <h3 id="ie-ai" className="t-panel">{e.aiTitle}</h3>
      <p className="text-sm text-[var(--color-muted)]">{e.aiNote}</p>
      <div className="flex flex-wrap gap-2">
        {AI_TOOLS.map((tool) => (
          <Link key={tool} href={path(`/create?tool=${tool}&source=${encodeURIComponent(assetId)}`)} className="btn-quiet">
            {t.gen.kinds[tool]}
          </Link>
        ))}
      </div>
      <p className="text-xs text-[var(--color-muted)]">{e.aiSaveFirst}</p>
    </section>
  );
}
