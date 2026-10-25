"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { formatMediaBytes } from "@/lib/media";
import { EditorCanvas, type CanvasKey, type Tool } from "@/components/imageEditor/EditorCanvas";
import { AdjustPanel, AiPanel, CropPanel, LayerPanel, useLayerName } from "@/components/imageEditor/panels";
import { previewScale, renderBase } from "@/components/imageEditor/render";
import { NEUTRAL_ADJUST, clampAdjust, type AdjustKey } from "@/lib/imageEditor/adjust";
import { aspectRatio, clampCrop, fitAspect, fullRect, resizeCrop, type AspectId } from "@/lib/imageEditor/crop";
import {
  canRedo,
  canUndo,
  createHistory,
  push,
  redo,
  seal,
  undo,
  type History,
} from "@/lib/imageEditor/history";
import {
  MAX_LAYERS,
  addLayer,
  newShape,
  newText,
  removeLayer,
  updateLayer,
  type Layer,
  type LayerPatch,
  type ShapeKind,
} from "@/lib/imageEditor/layers";
import { SAVE_FORMATS, editedName, saveErrorCode, SAVE_MIME, uploadEdited, type SaveError, type SaveFormat } from "@/lib/imageEditor/save";
import {
  MAX_EDIT_PIXELS,
  canvasSize,
  flipHorizontal,
  flipVertical,
  initialState,
  isEditableMime,
  isEdited,
  outputSize,
  rotateCcw,
  rotateCw,
  tooManyPixels,
  withCrop,
  type EditState,
} from "@/lib/imageEditor/state";
import { moveRect, type Size } from "@/lib/regionEdit/geometry";

type Loaded =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "unsupported" }
  | { status: "nosize" }
  | { status: "toolarge"; mp: number }
  | { status: "ready"; img: HTMLImageElement; src: Size };

type SaveView =
  | { status: "idle" }
  | { status: "preparing" }
  | { status: "saving" }
  | { status: "saved"; name: string }
  | { status: "error"; code: SaveError; maxBytes: number | null };

const megapixels = (s: Size): number => Math.round((s.width * s.height) / 100_000) / 10;

/** The picture's signed link comes from the same route the Library uses (RLS: this organization's live files only). */
async function loadPicture(id: string): Promise<Exclude<Loaded, { status: "loading" }>> {
  try {
    const res = await fetch(`/api/media/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) return { status: "failed" };
    const body = (await res.json()) as {
      asset?: { kind?: string; mime?: string; width?: number | null; height?: number | null };
      urls?: Record<string, string>;
      served?: boolean;
    };
    const asset = body.asset;
    const url = body.urls?.original;
    if (!asset || asset.kind !== "image" || !body.served || !url) return { status: "failed" };
    if (!isEditableMime(asset.mime)) return { status: "unsupported" };
    const w = asset.width;
    const h = asset.height;
    if (typeof w !== "number" || typeof h !== "number" || w <= 0 || h <= 0) return { status: "nosize" };
    // Before a single byte of a huge picture is downloaded.
    if (tooManyPixels({ width: w, height: h })) return { status: "toolarge", mp: megapixels({ width: w, height: h }) };
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new window.Image();
      el.onload = () => resolve(el);
      el.onerror = () => resolve(null);
      el.src = url;
    });
    if (!img) return { status: "failed" };
    // What the browser decoded (EXIF turn applied) is the grid the edit works on, not the library's recorded size.
    const src = { width: img.naturalWidth, height: img.naturalHeight };
    if (src.width <= 0 || src.height <= 0) return { status: "failed" };
    if (tooManyPixels(src)) return { status: "toolarge", mp: megapixels(src) };
    return { status: "ready", img, src };
  } catch {
    return { status: "failed" };
  }
}

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `l${Date.now()}${Math.random().toString(16).slice(2)}`);

const TOOLS: readonly Tool[] = ["crop", "adjust", "text", "shapes", "ai"];

/**
 * The image editor (NIGHTSHIFT_IMAGE_EDITOR, default off): crop, turn, flip, colours, text and shapes on one library
 * picture, all in the browser. Save flattens the result with a canvas and uploads it as a NEW library file through the
 * existing upload ticket; the original is never touched. The AI operations are links into Studio.
 */
export function ImageEditor({ assetId, orgId, name, libraryHref }: { assetId: string; orgId: string; name: string; libraryHref: string }) {
  const { t, fmt } = useI18n();
  const e = t.imageEditor;
  const path = useChannelPath();
  const keysId = useId();
  const layerName = useLayerName();

  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [hist, setHist] = useState<History<EditState>>(() => createHistory(initialState()));
  // Updated synchronously so two events in one frame (a held arrow key) both see the latest state.
  const histRef = useRef(hist);
  const [tool, setTool] = useState<Tool>("crop");
  const [aspect, setAspect] = useState<AspectId>("free");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [format, setFormat] = useState<SaveFormat>("png");
  const [save, setSave] = useState<SaveView>({ status: "idle" });
  const [live, setLive] = useState("");
  const saving = useRef(false);
  const savedState = useRef<EditState | null>(null);

  useEffect(() => {
    let dead = false;
    setLoaded({ status: "loading" });
    void loadPicture(assetId).then((r) => !dead && setLoaded(r));
    return () => {
      dead = true;
    };
  }, [assetId, reloadKey]);

  const src = loaded.status === "ready" ? loaded.src : null;
  const state = hist.present;

  const apply = useCallback((next: EditState, key: string | null = null) => {
    const h = push(histRef.current, next, key);
    if (h === histRef.current) return;
    histRef.current = h;
    setHist(h);
    // Any new change makes "saved" stale.
    setSave((s) => (s.status === "saved" || s.status === "error" ? { status: "idle" } : s));
  }, []);
  const end = useCallback(() => {
    histRef.current = seal(histRef.current);
    setHist(histRef.current);
  }, []);
  const announce = (text: string) => setLive(text);

  const canvas = src ? canvasSize(src, state.rotation) : { width: 1, height: 1 };
  const cropNow = state.crop ?? fullRect(canvas);
  const ratio = aspectRatio(aspect);
  const view = tool === "crop" ? fullRect(canvas) : cropNow;
  const out = src ? outputSize(src, state) : { width: 0, height: 0 };

  // The coloured picture for the preview, rebuilt only when the picture itself changes (not for text, shapes or crop).
  const base = useMemo(() => {
    if (loaded.status !== "ready") return null;
    try {
      return renderBase(loaded.img, loaded.src, state, fullRect(canvasSize(loaded.src, state.rotation)), previewScale(canvasSize(loaded.src, state.rotation)));
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, state.rotation, state.mirrored, state.adjust]);

  const dirty = isEdited(state) && savedState.current !== state;
  useEffect(() => {
    if (!dirty) return;
    const warn = (ev: BeforeUnloadEvent) => {
      ev.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // ── geometry ────────────────────────────────────────────────────────────────
  const turned = (next: EditState) => {
    // A turn swaps the crop's sides, so a locked shape would no longer be that shape.
    setAspect("free");
    apply(next);
    if (src) {
      const c = canvasSize(src, next.rotation);
      announce(fmt(e.announceTurned, { w: (next.crop ?? fullRect(c)).w, h: (next.crop ?? fullRect(c)).h }));
    }
  };

  const setCrop = (rect: { x: number; y: number; w: number; h: number }, key: string | null) => {
    if (!src) return;
    const s = histRef.current.present;
    const c = canvasSize(src, s.rotation);
    const fixed = ratio ? fitAspect(rect, ratio, c) : clampCrop(rect, c);
    apply(withCrop(s, fixed, src), key);
  };

  const pickAspect = (a: AspectId) => {
    setAspect(a);
    const r = aspectRatio(a);
    if (r && src) {
      const s = histRef.current.present;
      const c = canvasSize(src, s.rotation);
      apply(withCrop(s, fitAspect(s.crop ?? fullRect(c), r, c), src));
    }
  };

  const cropField = (field: "x" | "y" | "w" | "h", n: number) => {
    if (!src) return;
    const s = histRef.current.present;
    const c = canvasSize(src, s.rotation);
    const cur = s.crop ?? fullRect(c);
    const next = field === "w" || field === "h" ? resizeCrop(cur, { [field]: n }, ratio, c) : moveRect(cur, field === "x" ? n - cur.x : 0, field === "y" ? n - cur.y : 0, c);
    apply(withCrop(s, next, src), `crop-${field}`);
  };

  // ── colours ─────────────────────────────────────────────────────────────────
  const setAdjust = (key: AdjustKey, value: number) => {
    const s = histRef.current.present;
    apply({ ...s, adjust: { ...s.adjust, [key]: clampAdjust(value) } }, `adjust-${key}`);
  };

  // ── layers ──────────────────────────────────────────────────────────────────
  const addOne = (kind: "text" | ShapeKind) => {
    if (!src) return;
    const s = histRef.current.present;
    const layer: Layer = kind === "text" ? newText(newId(), canvas, e.textDefault) : newShape(newId(), kind, canvas);
    const res = addLayer(s.layers, layer);
    if (!res.ok) return;
    apply({ ...s, layers: res.layers });
    setSelectedId(layer.id);
    announce(fmt(e.announceAdded, { name: layerName(res.layers, layer) }));
  };
  const patchLayer = (id: string, patch: LayerPatch, key: string | null) => {
    const s = histRef.current.present;
    apply({ ...s, layers: updateLayer(s.layers, id, patch, canvas) }, key);
  };
  const removeOne = (id: string) => {
    const s = histRef.current.present;
    const gone = s.layers.find((l) => l.id === id);
    if (gone) announce(fmt(e.announceRemoved, { name: layerName(s.layers, gone) }));
    apply({ ...s, layers: removeLayer(s.layers, id) });
    setSelectedId((cur) => (cur === id ? null : cur));
  };

  const onKey = (a: CanvasKey) => {
    if (!src) return;
    const s = histRef.current.present;
    if (tool === "crop") {
      if (a.type === "move") setCrop(moveRect(cropNow, a.dx, a.dy, canvas), "kb-crop");
      else if (a.type === "resize") setCrop(resizeCrop(cropNow, { w: cropNow.w + a.dx, h: cropNow.h + a.dy }, ratio, canvas), "kb-crop");
      return;
    }
    if (tool !== "text" && tool !== "shapes") return;
    const pool = s.layers.filter((l) => (tool === "text" ? l.kind === "text" : l.kind !== "text"));
    if (a.type === "cycle") {
      if (pool.length === 0) return;
      const i = pool.findIndex((l) => l.id === selectedId);
      const next = pool[(i + a.dir + pool.length) % pool.length];
      setSelectedId(next.id);
      announce(fmt(e.announceSelected, { name: layerName(s.layers, next) }));
      return;
    }
    const picked = pool.find((l) => l.id === selectedId);
    if (!picked) return;
    if (a.type === "remove") return removeOne(picked.id);
    if (a.type === "move") {
      patchLayer(picked.id, { cx: picked.cx + a.dx, cy: picked.cy + a.dy }, "kb-layer");
      announce(fmt(e.announceMoved, { name: layerName(s.layers, picked), x: picked.cx + a.dx, y: picked.cy + a.dy }));
    }
  };

  // ── undo / redo ─────────────────────────────────────────────────────────────
  const doUndo = () => {
    histRef.current = undo(histRef.current);
    setHist(histRef.current);
    announce(e.announceUndo);
  };
  const doRedo = () => {
    histRef.current = redo(histRef.current);
    setHist(histRef.current);
    announce(e.announceRedo);
  };
  const onShortcut = (ev: React.KeyboardEvent) => {
    const el = ev.target as HTMLElement;
    if (el.closest("input, textarea, select")) return;
    if (!(ev.ctrlKey || ev.metaKey)) return;
    const k = ev.key.toLowerCase();
    if (k === "z") {
      ev.preventDefault();
      if (ev.shiftKey) doRedo();
      else doUndo();
    } else if (k === "y") {
      ev.preventDefault();
      doRedo();
    }
  };
  // The selection must exist in the current state (undo can remove a layer).
  const selected = state.layers.some((l) => l.id === selectedId) ? selectedId : null;

  // ── save ────────────────────────────────────────────────────────────────────
  const doSave = async () => {
    if (!src || loaded.status !== "ready" || saving.current || !isEdited(state)) return;
    saving.current = true;
    const snapshot = state;
    try {
      setSave({ status: "preparing" });
      let blob: Blob;
      try {
        const Konva = (await import("konva")).default;
        const { exportPicture } = await import("@/components/imageEditor/scene");
        blob = await exportPicture(Konva, loaded.img, src, snapshot, format);
      } catch {
        setSave({ status: "error", code: "export_failed", maxBytes: null });
        return;
      }
      setSave({ status: "saving" });
      const res = await uploadEdited({ orgId, blob, filename: editedName(name, format), mime: SAVE_MIME[format] });
      if (res.ok) {
        savedState.current = snapshot;
        setSave({ status: "saved", name: res.name });
      } else {
        setSave({ status: "error", code: saveErrorCode(res.error), maxBytes: res.maxBytes ?? null });
      }
    } finally {
      saving.current = false;
    }
  };

  // ── render ──────────────────────────────────────────────────────────────────
  if (loaded.status === "loading") return <p className="text-sm text-[var(--color-muted)]" role="status">{e.loading}</p>;
  if (loaded.status !== "ready" || !src) {
    const text =
      loaded.status === "unsupported" ? e.unsupported
      : loaded.status === "nosize" ? e.noSize
      : loaded.status === "toolarge" ? fmt(e.tooLarge, { mp: loaded.mp, max: MAX_EDIT_PIXELS / 1_000_000 })
      : e.imageFailed;
    return (
      <div className="flex flex-col gap-3" role="alert">
        <p className="text-sm text-[var(--color-fail)]">{text}</p>
        <div className="flex flex-wrap gap-2">
          {loaded.status === "failed" ? <button type="button" className="btn-quiet" onClick={() => setReloadKey((n) => n + 1)}>{e.retry}</button> : null}
          <Link href={libraryHref} className="btn-quiet">{e.libraryLink}</Link>
        </div>
      </div>
    );
  }

  const busy = save.status === "preparing" || save.status === "saving";
  const edited = isEdited(state);
  const errorText =
    save.status === "error" ? fmt((e.errors as Record<string, string>)[save.code] ?? e.errors.failed, { max: formatMediaBytes(save.maxBytes) || "—" }) : "";

  return (
    <div className="flex flex-col gap-5" onKeyDown={onShortcut}>
      <p className="g3-note">{e.previewNote}</p>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-quiet" disabled={!canUndo(hist)} onClick={doUndo}>{e.undo}</button>
        <button type="button" className="btn-quiet" disabled={!canRedo(hist)} onClick={doRedo}>{e.redo}</button>
        <span className="ml-auto text-xs text-[var(--color-muted)]">{fmt(e.outputSize, { w: out.width, h: out.height })}</span>
      </div>

      <EditorCanvas
        base={base}
        canvas={canvas}
        view={view}
        layers={state.layers}
        selectedId={selected}
        tool={tool}
        crop={cropNow}
        ratio={ratio}
        label={fmt(e.canvasLabel, { w: out.width, h: out.height, n: state.layers.length, max: MAX_LAYERS })}
        keysId={keysId}
        onSelect={setSelectedId}
        onMove={(id, cx, cy) => patchLayer(id, { cx, cy }, null)}
        onBox={(id, w, h) => patchLayer(id, { w, h }, null)}
        onCrop={(rect) => setCrop(rect, null)}
        onKey={onKey}
        onKeyEnd={end}
      />
      <p id={keysId} className="text-xs text-[var(--color-muted)]">{e.canvasKeys}</p>
      <p className="sr-only" role="status" aria-live="polite">{live}</p>

      <div role="toolbar" aria-label={e.toolsLabel} className="flex flex-wrap gap-2">
        {TOOLS.map((id) => (
          <button
            key={id}
            type="button"
            className={tool === id ? "btn-primary" : "btn-quiet"}
            aria-pressed={tool === id}
            onClick={() => {
              setTool(id);
              if (id !== "text" && id !== "shapes") setSelectedId(null);
            }}
          >
            {e.tools[id]}
          </button>
        ))}
      </div>

      <div>
        {tool === "crop" ? (
          <CropPanel
            crop={cropNow}
            canvas={canvas}
            aspect={aspect}
            onAspect={pickAspect}
            onField={cropField}
            onEnd={end}
            hasCrop={state.crop !== null}
            onReset={() => {
              setAspect("free");
              apply(withCrop(histRef.current.present, null, src));
            }}
            onRotateLeft={() => turned(rotateCcw(histRef.current.present, src))}
            onRotateRight={() => turned(rotateCw(histRef.current.present, src))}
            onFlipH={() => turned(flipHorizontal(histRef.current.present, src))}
            onFlipV={() => turned(flipVertical(histRef.current.present, src))}
          />
        ) : null}
        {tool === "adjust" ? (
          <AdjustPanel
            adjust={state.adjust}
            onChange={setAdjust}
            onEnd={end}
            onReset={() => apply({ ...histRef.current.present, adjust: NEUTRAL_ADJUST })}
          />
        ) : null}
        {tool === "text" || tool === "shapes" ? (
          <LayerPanel
            mode={tool}
            layers={state.layers}
            selectedId={selected}
            canvas={canvas}
            onAdd={addOne}
            onSelect={(id) => {
              setSelectedId(id);
              const l = state.layers.find((x) => x.id === id);
              if (l) announce(fmt(e.announceSelected, { name: layerName(state.layers, l) }));
            }}
            onRemove={removeOne}
            onPatch={(id, patch, key) => patchLayer(id, patch, key)}
            onEnd={end}
          />
        ) : null}
        {tool === "ai" ? <AiPanel assetId={assetId} path={path} /> : null}
      </div>

      <section aria-labelledby="ie-save" className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-4">
        <h2 id="ie-save" className="t-panel">{e.saveTitle}</h2>
        <div className="flex flex-col gap-1">
          <label htmlFor="ie-format" className="studio-label">{e.formatLabel}</label>
          <div className="studio-field">
            <select
              id="ie-format"
              value={format}
              disabled={busy}
              onChange={(ev) => setFormat(ev.target.value as SaveFormat)}
              className="min-h-11 w-full bg-transparent px-3 text-base text-[var(--color-fg)] outline-none sm:text-[14px]"
            >
              {SAVE_FORMATS.map((f) => (
                <option key={f} value={f}>{f === "png" ? e.formatPng : e.formatJpeg}</option>
              ))}
            </select>
          </div>
          <p className="text-xs text-[var(--color-muted)]">{e.formatHint}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn-primary" disabled={!edited || busy} aria-disabled={!edited || busy} onClick={() => void doSave()}>
            {save.status === "preparing" ? e.preparing : save.status === "saving" ? e.saving : e.save}
          </button>
          {dirty && !busy ? <span className="text-xs text-[var(--color-muted)]">{e.unsaved}</span> : null}
        </div>
        {!edited ? <p className="text-sm text-[var(--color-muted)]">{e.nothingToSave}</p> : null}
        {save.status === "saved" ? (
          <div className="flex flex-wrap items-center gap-3" role="status">
            <p className="text-sm">{fmt(e.saved, { name: save.name })}</p>
            <Link href={libraryHref} className="btn-quiet">{e.savedLink}</Link>
          </div>
        ) : null}
        {save.status === "error" ? (
          <div className="flex flex-wrap items-center gap-3" role="alert">
            <p className="text-sm text-[var(--color-fail)]">{errorText}</p>
            <button type="button" className="btn-quiet" onClick={() => void doSave()}>{e.retry}</button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
