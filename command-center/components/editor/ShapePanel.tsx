"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { ArrowDown, ArrowUp, RotateCcw, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { Timecode } from "@/components/ui/Timecode";
import { HEX_RE, formatTime, type EditorModel } from "@/lib/editor";
import { animFrame } from "@/lib/editorFxPreview";
import { overlayBoxStyle } from "@/lib/editorOverlay";
import {
  canMoveShape,
  clearShapeMove,
  setShapeEnd,
  shapeAt,
  shapeEndOf,
  shapeLength,
  startShapeMove,
} from "@/lib/editorShapeModel";
import {
  ARROW_DIRS,
  ASPECT_MAX,
  ASPECT_MIN,
  PILL_LABELS,
  SHAPE_KINDS,
  SHAPE_MOVE_KEYS,
  SHAPE_OUTLINE_MAX,
  SHAPE_W_MAX,
  SHAPE_W_MIN,
  SHAPE_TEXT_MAX,
  THICK_MAX,
  THICK_MIN,
  arrowPoints,
  cleanShapeText,
  contrastOn,
  kindTakes,
  progressFill,
  shapePx,
  shapeTextProblem,
  starPoints,
  type ArrowDir,
  type ProgressEdge,
  type ShapeKind,
  type ShapeLayer,
  type ShapeMoveKey,
} from "@/lib/editorShapes";
import { Disclosure, RadioChips, SliderRow, ToggleRow } from "./FxControls";
import { SecondsField } from "./OverlayPanel";

/**
 * Shapes and stickers in the editor: the layer drawn in the preview, the picker
 * (visual tiles in a radio group) and the inspector (when, where, how big, which
 * colour, the kind's own controls). The editor decides what a change means (the
 * model clamps and keeps the history); these only report them.
 *
 * The preview draws the same polygons the export does as SVG, so a shape is close
 * to exact; a label's width is an estimate and the entrance / exit a rough picture.
 */

const fieldClass =
  "rounded-[var(--ns-r-key)] w-full min-h-11 border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-base text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[13px]";
const quietBtn = "btn-quiet inline-flex items-center gap-1.5 px-3 py-1.5 text-xs";
const note = "m-0 text-xs text-[var(--color-muted)]";

/** The ready colours: a closed list, each shown with its name (never colour alone). */
export const SHAPE_SWATCHES = [
  { id: "yellow", hex: "#FFD60A" },
  { id: "red", hex: "#FF3B30" },
  { id: "green", hex: "#34C759" },
  { id: "blue", hex: "#0A84FF" },
  { id: "white", hex: "#FFFFFF" },
  { id: "black", hex: "#000000" },
] as const;

// ── what a shape looks like (preview and tiles) ─────────────────────────────

/** The shape drawn into a `pw` x `ph` viewBox (the export's own polygons); the colour is the
 *  shape's, the stroke is `outline` of the shorter side (0 = solid). */
function ShapeSvg({
  kind,
  dir = "right",
  outline = 0,
  color,
  pw,
  ph,
}: {
  kind: ShapeKind;
  dir?: ArrowDir;
  outline?: number;
  color: string;
  pw: number;
  ph: number;
}) {
  const stroke = outline * Math.min(pw, ph);
  const ring = stroke > 0;
  const common = ring
    ? { fill: "none", stroke: color, strokeWidth: stroke }
    : { fill: color, stroke: "none" };
  let body: ReactNode = null;
  if (kind === "circle")
    body = (
      <ellipse
        cx={pw / 2}
        cy={ph / 2}
        rx={Math.max(0.1, pw / 2 - stroke / 2)}
        ry={Math.max(0.1, ph / 2 - stroke / 2)}
        {...common}
      />
    );
  else if (kind === "rect")
    body = (
      <rect
        x={stroke / 2}
        y={stroke / 2}
        width={Math.max(0.1, pw - stroke)}
        height={Math.max(0.1, ph - stroke)}
        {...common}
      />
    );
  else if (kind === "star")
    body = (
      <polygon
        points={starPoints(pw, ph, ring ? stroke * 0.8 : 0)}
        strokeLinejoin="miter"
        {...(ring ? { ...common, strokeWidth: stroke * 1.2 } : common)}
      />
    );
  else if (kind === "arrow") {
    const vertical = dir === "up" || dir === "down";
    const [long, short] = vertical ? [ph, pw] : [pw, ph];
    const transform =
      dir === "left"
        ? `translate(${pw} 0) scale(-1 1)`
        : dir === "up"
          ? `translate(0 ${ph}) rotate(-90)`
          : dir === "down"
            ? `translate(${pw} 0) rotate(90)`
            : undefined;
    body = <polygon points={arrowPoints(long, short)} transform={transform} fill={color} />;
  } else if (kind === "line")
    body = <rect x={0} y={0} width={pw} height={ph} rx={ph / 2} fill={color} />;
  return (
    <svg
      viewBox={`0 0 ${pw} ${ph}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      className="block size-full overflow-visible"
    >
      {body}
    </svg>
  );
}

/** The inner part of a label (pill) at the preview's scale: a rounded box and its words. */
function PillBody({
  s,
  boxPx,
  frameW,
}: {
  s: ShapeLayer;
  boxPx: [number, number];
  frameW: number;
}) {
  const [, ph] = boxPx;
  const ring = (s.outline ?? 0) > 0;
  const strokePx = (s.outline ?? 0) * ph;
  return (
    <span
      className="flex size-full items-center justify-center overflow-hidden whitespace-nowrap font-bold leading-none"
      style={{
        borderRadius: "9999px",
        background: ring ? "transparent" : s.color,
        border: ring ? `${(strokePx / frameW) * 100}cqw solid ${s.color}` : undefined,
        color: ring ? s.color : contrastOn(s.color),
        // The export's font is the box's height over 1.55; cqw is a share of the preview's width.
        fontSize: `${((ph / 1.55) / frameW) * 100}cqw`,
        boxSizing: "border-box",
      }}
    >
      {s.text}
    </span>
  );
}

/** The ready-made look of one shape for a tile: a small SVG on the film colour. */
function KindGlyph({ kind }: { kind: ShapeKind }) {
  const c = "currentColor";
  if (kind === "pill")
    return (
      <svg viewBox="0 0 44 24" aria-hidden="true" focusable="false" className="h-6 w-11 shrink-0">
        <rect x="1.5" y="4" width="41" height="16" rx="8" fill={c} />
        <rect x="9" y="10.5" width="26" height="3" rx="1.5" fill="var(--ns-film)" />
      </svg>
    );
  if (kind === "progress")
    return (
      <svg viewBox="0 0 44 24" aria-hidden="true" focusable="false" className="h-6 w-11 shrink-0">
        <rect x="1.5" y="10" width="41" height="4" rx="0" fill={c} opacity="0.35" />
        <rect x="1.5" y="10" width="24" height="4" rx="0" fill={c} />
      </svg>
    );
  const [pw, ph] = kind === "arrow" ? [30, 15] : kind === "line" ? [36, 4] : kind === "rect" ? [32, 20] : [20, 20];
  return (
    <svg viewBox="0 0 44 24" aria-hidden="true" focusable="false" className="h-6 w-11 shrink-0">
      <g transform={`translate(${(44 - pw) / 2} ${(24 - ph) / 2})`}>
        <ShapeSvg
          kind={kind}
          color={c}
          pw={pw}
          ph={ph}
          outline={kind === "circle" || kind === "rect" ? 0.14 : 0}
        />
      </g>
    </svg>
  );
}

// ── the preview layer ───────────────────────────────────────────────────────

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * The shapes on screen at the playhead, drawn in the preview box (the parent clips what leaves the
 * frame) with the same fractions the export uses, plus a frame around the selected one (a real
 * button a keyboard can reach: arrow keys move it, a pointer can drag it). A progress bar has no
 * position, so it has no frame.
 */
export function ShapeLayerView({
  shapes,
  selectedId,
  numberOf,
  playhead,
  frame,
  fps,
  onNudge,
  onDrag,
  onDragEnd,
}: {
  /** Those on screen at the playhead, bottom layer first. */
  shapes: readonly ShapeLayer[];
  selectedId: string | null;
  /** 1-based place in the document's list. */
  numberOf: (id: string) => number;
  playhead: number;
  frame: { width: number; height: number };
  fps: number;
  onNudge: (id: string, dx: number, dy: number, big: boolean) => void;
  onDrag: (id: string, x: number, y: number) => void;
  onDragEnd: () => void;
}) {
  const { t } = useI18n();
  const ts = t.editor.shapes;
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x0: number; y0: number; cx: number; cy: number; w: number; h: number } | null>(null);
  const selected = shapes.find((s) => s.id === selectedId && s.kind !== "progress") ?? null;

  function onKey(e: KeyboardEvent<HTMLElement>, s: ShapeLayer) {
    const dir = ARROWS[e.key];
    if (!dir || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    onNudge(s.id, dir[0], dir[1], e.shiftKey);
  }
  function onDown(e: PointerEvent<HTMLElement>, s: ShapeLayer) {
    const box = root.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const at = shapeAt(s, playhead);
    drag.current = { x0: e.clientX, y0: e.clientY, cx: s.x ?? at.x, cy: s.y ?? at.y, w: box.width, h: box.height };
  }
  function onMove(e: PointerEvent<HTMLElement>, s: ShapeLayer) {
    const d = drag.current;
    if (!d) return;
    onDrag(s.id, d.cx + (e.clientX - d.x0) / d.w, d.cy + (e.clientY - d.y0) / d.h);
  }
  function onUp() {
    if (!drag.current) return;
    drag.current = null;
    onDragEnd();
  }

  const frameStyle = (s: ShapeLayer): CSSProperties => {
    const at = shapeAt(s, playhead);
    const [pw, ph] = shapePx(s, at.w, frame);
    return { ...overlayBoxStyle(at), aspectRatio: `${pw} / ${ph}` };
  };

  return (
    <div ref={root} className="pointer-events-none absolute inset-0 z-0">
      {shapes.map((s, i) => {
        const f = animFrame(s, playhead);
        const opacity = s.opacity * f.opacity;
        if (s.kind === "progress") {
          const [pw, ph] = shapePx(s, 1, frame);
          const fill = progressFill(s, playhead, fps);
          return (
            <div
              key={s.id}
              data-shape={s.id}
              data-testid="shape-item"
              data-kind="progress"
              className="absolute left-0 w-full overflow-hidden"
              style={{
                aspectRatio: `${pw} / ${ph}`,
                ...(s.edge === "top" ? { top: 0 } : { bottom: 0 }),
                opacity,
                zIndex: i + 1,
              }}
            >
              <div
                data-testid="progress-fill"
                className="h-full"
                style={{ width: `${(fill * 100).toFixed(2)}%`, background: s.color }}
              />
            </div>
          );
        }
        const at = shapeAt(s, playhead);
        const [pw, ph] = shapePx(s, at.w, frame);
        const moving = f.dx !== 0 || f.dy !== 0 || f.scale !== 1;
        const style: CSSProperties = {
          ...frameStyle(s),
          ...(moving
            ? {
                transform: `translate(${f.dx * 100}cqw, ${f.dy * 100 * (frame.height / frame.width)}cqw) translate(-50%, -50%) scale(${f.scale})`,
              }
            : {}),
          opacity,
          pointerEvents: "none",
          zIndex: i + 1,
        };
        return (
          <div key={s.id} data-shape={s.id} data-testid="shape-item" data-kind={s.kind} style={style}>
            {s.kind === "pill" ? (
              <PillBody s={s} boxPx={[pw, ph]} frameW={frame.width} />
            ) : (
              <ShapeSvg kind={s.kind} dir={s.dir} outline={s.outline} color={s.color} pw={pw} ph={ph} />
            )}
          </div>
        );
      })}
      {selected ? (
        <div
          data-testid="shape-frame"
          className="pointer-events-none"
          style={{ ...frameStyle(selected), zIndex: 1000 }}
        >
          <button
            type="button"
            data-shape-frame={selected.id}
            aria-label={fmt(ts.handle, { n: numberOf(selected.id) })}
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

// ── the kind tiles (the picker and the inspector's "Shape" group) ───────────

/** The seven kinds as visual tiles in a native radio group: a key at least 44px tall, the shape
 *  drawn beside its name (the name is the accessible name; the drawing is decoration). */
export function ShapeKindTiles({
  value,
  onChange,
  testId = "shape-kinds",
}: {
  value: ShapeKind | null;
  onChange: (kind: ShapeKind) => void;
  testId?: string;
}) {
  const { t } = useI18n();
  const ts = t.editor.shapes;
  const id = useId();
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0" data-testid={testId}>
      <legend className="mb-1 p-0 text-xs text-[var(--color-muted)]">{ts.kindLegend}</legend>
      <div
        className="grid gap-1.5"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(9.5rem, 1fr))" }}
      >
        {SHAPE_KINDS.map((k) => {
          const on = value === k;
          return (
            <label
              key={k}
              className="ns-chip min-w-0"
              style={{ minHeight: "2.75rem" }}
              data-radio=""
              data-on={on ? "true" : undefined}
              data-kind={k}
            >
              <input
                type="radio"
                name={`${id}-kind`}
                value={k}
                checked={on}
                onChange={() => onChange(k)}
                aria-label={ts.kinds[k]}
                className="sr-only"
              />
              <KindGlyph kind={k} />
              <span className="min-w-0 break-words leading-tight" aria-hidden>
                {ts.kinds[k]}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** The ready labels as buttons (a label is typed or one of these); each fills the text box. */
function ReadyLabels({ onPick }: { onPick: (text: string) => void }) {
  const { t } = useI18n();
  const ts = t.editor.shapes;
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex min-w-0 flex-col gap-1.5">
      <span id={id} className="text-xs text-[var(--color-muted)]">
        {ts.readyLegend}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {PILL_LABELS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onPick(ts.labels[k])}
            className="ns-chip min-w-0"
            style={{ minHeight: "2.75rem" }}
          >
            {ts.labels[k]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The label's text box: commits every valid change; an empty box keeps the last words and says so. */
function LabelField({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (text: string) => void;
}) {
  const { t } = useI18n();
  const ts = t.editor.shapes;
  const [draft, setDraft] = useState(value);
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    setDraft(value);
    setEmpty(false);
  }, [value]);
  const hint = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-muted)]">
        {ts.text}
        <input
          type="text"
          value={draft}
          autoComplete="off"
          aria-describedby={hint}
          onChange={(e) => {
            const cleaned = cleanShapeText(e.target.value);
            setDraft(cleaned);
            if (shapeTextProblem(cleaned)) {
              setEmpty(true);
              return;
            }
            setEmpty(false);
            if (cleaned !== value) onCommit(cleaned);
          }}
          className={fieldClass}
        />
      </label>
      <p id={hint} className={note}>
        {fmt(ts.textHint, { max: SHAPE_TEXT_MAX })}
      </p>
      {empty ? (
        <p role="status" className="m-0 text-xs text-[var(--color-warn)]">
          {ts.textEmpty}
        </p>
      ) : null}
    </div>
  );
}

// ── the picker (Add shape) ──────────────────────────────────────────────────

export function ShapePicker({
  onAdd,
  onClose,
}: {
  onAdd: (kind: ShapeKind, text: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ts = t.editor.shapes;
  const heading = useId();
  const [kind, setKind] = useState<ShapeKind>("arrow");
  const [text, setText] = useState<string>(ts.labels.subscribe);
  return (
    <section aria-labelledby={heading} className="panel flex flex-col gap-3 p-4 sm:p-5" data-testid="shape-picker">
      <div className="flex items-center justify-between gap-2">
        <h3 id={heading} className="m-0 text-sm font-semibold">
          {ts.addTitle}
        </h3>
        <button type="button" onClick={onClose} className={`${quietBtn} min-h-11`}>
          {t.editor.close}
        </button>
      </div>
      <ShapeKindTiles value={kind} onChange={setKind} />
      {kind === "pill" ? (
        <>
          <ReadyLabels onPick={setText} />
          <LabelField value={text} onCommit={setText} />
        </>
      ) : null}
      <button
        type="button"
        onClick={() => onAdd(kind, text)}
        className="btn-primary min-h-11 self-start text-sm"
      >
        {ts.addConfirm}
      </button>
    </section>
  );
}

// ── colour ──────────────────────────────────────────────────────────────────

function ColorField({
  value,
  onChange,
}: {
  value: string;
  onChange: (hex: string, burst?: string) => void;
}) {
  const { t } = useI18n();
  const ts = t.editor.shapes;
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setDraft(value);
    setBad(false);
  }, [value]);
  const commit = () => {
    const v = draft.trim();
    if (HEX_RE.test(v)) {
      setBad(false);
      if (v.toUpperCase() !== value) onChange(v.toUpperCase());
    } else {
      setBad(true);
    }
  };
  const named = SHAPE_SWATCHES.find((s) => s.hex === value)?.id ?? null;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="shape-color">
      <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0" data-testid="shape-swatches">
        <legend className="mb-1 p-0 text-xs text-[var(--color-muted)]">{ts.colorLegend}</legend>
        <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(6rem, 1fr))" }}>
          {SHAPE_SWATCHES.map((sw) => {
            const on = named === sw.id;
            return (
              <label
                key={sw.id}
                className="ns-chip min-w-0"
                style={{ minHeight: "2.75rem" }}
                data-radio=""
                data-on={on ? "true" : undefined}
              >
                <input
                  type="radio"
                  name={`${id}-swatch`}
                  value={sw.id}
                  checked={on}
                  onChange={() => onChange(sw.hex)}
                  className="sr-only"
                />
                <span
                  aria-hidden
                  className="size-3.5 shrink-0 rounded-full border border-[var(--color-border)]"
                  style={{ background: sw.hex }}
                />
                <span className="min-w-0 break-words leading-tight">{ts.swatches[sw.id]}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="flex items-end gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-muted)]">
          <span className="sr-only">{ts.colorPicker}</span>
          <input
            type="color"
            value={value.toLowerCase()}
            aria-label={ts.colorPicker}
            onChange={(e) => onChange(e.target.value.toUpperCase(), `${id}:color`)}
            className="block h-11 w-14 cursor-pointer rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-transparent p-1"
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-left text-xs text-[var(--color-muted)]">
          {ts.colorCode}
          <input
            type="text"
            value={draft}
            spellCheck={false}
            autoCapitalize="characters"
            aria-invalid={bad || undefined}
            aria-describedby={bad ? `${id}-bad` : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              setBad(false);
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
            className={fieldClass}
          />
        </label>
      </div>
      {bad ? (
        <p id={`${id}-bad`} role="status" className="m-0 text-xs text-[var(--color-warn)]">
          {ts.colorBad}
        </p>
      ) : null}
    </div>
  );
}

// ── the inspector ───────────────────────────────────────────────────────────

const pct = (v: number) => Math.round(v * 100);

export function ShapeInspector({
  n,
  total,
  shape,
  warning,
  onChange,
  onKind,
  onSpan,
  onReset,
  onToPlayhead,
  onLayer,
  extra,
  onDelete,
}: {
  n: number;
  total: number;
  shape: ShapeLayer;
  warning: "past_end" | "cut_end" | "invisible" | null;
  /** `burst` names a run of small changes that is one undo step. */
  onChange: (patch: Partial<Omit<ShapeLayer, "id" | "kind">>, burst?: string) => void;
  onKind: (kind: ShapeKind) => void;
  /** The progress bar's span: the whole video or the clip at the playhead. */
  onSpan: (which: "video" | "clip") => void;
  onReset: () => void;
  onToPlayhead: () => void;
  onLayer: (by: -1 | 1) => void;
  /** More sections (entrance / exit, move), under the basics. */
  extra?: ReactNode;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const te = t.editor;
  const ts = te.shapes;
  const g = shape.id;
  const len = shapeLength(shape);
  const takes = (f: string) => kindTakes(shape.kind, f);
  const percent = (label: string, value: number, lo: number, hi: number, key: string, set: (v: number) => Partial<ShapeLayer>) => (
    <SliderRow
      label={label}
      value={pct(value)}
      min={pct(lo)}
      max={pct(hi)}
      step={1}
      text={fmt(ts.percent, { v: pct(value) })}
      onChange={(v) => onChange(set(v / 100), `${g}:${key}`)}
    />
  );
  return (
    <>
      <h2 tabIndex={-1} data-shape-heading="" className="m-0 text-sm font-semibold outline-none">
        {fmt(ts.heading, { n, kind: ts.kinds[shape.kind] })}
      </h2>
      <p className="m-0 truncate text-xs text-[var(--color-muted)]">
        <Timecode value={len} format="duration" label={formatTime(len)} />
      </p>
      {warning ? (
        <p role="status" className="m-0 text-xs text-[var(--color-warn)]">
          {warning === "past_end" ? ts.pastEnd : warning === "cut_end" ? ts.cutEnd : ts.invisible}
        </p>
      ) : null}
      <ShapeKindTiles value={shape.kind} onChange={onKind} testId="shape-kind-inspector" />
      <div className="grid grid-cols-2 gap-2">
        <SecondsField
          label={ts.start}
          value={shape.start_s}
          min={0}
          onCommit={(v) => onChange({ start_s: v })}
        />
        <SecondsField
          label={ts.end}
          value={shape.end_s}
          min={shape.start_s}
          onCommit={(v) => onChange({ end_s: v })}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onToPlayhead} className={`${quietBtn} min-h-11`}>
          {ts.toPlayhead}
        </button>
        {shape.kind === "progress" ? (
          <>
            <button type="button" onClick={() => onSpan("video")} className={`${quietBtn} min-h-11`}>
              {ts.wholeVideo}
            </button>
            <button type="button" onClick={() => onSpan("clip")} className={`${quietBtn} min-h-11`}>
              {ts.atClip}
            </button>
          </>
        ) : null}
      </div>
      <ColorField value={shape.color} onChange={(hex, burst) => onChange({ color: hex }, burst ? `${g}:${burst}` : undefined)} />
      {takes("text") ? (
        <>
          <ReadyLabels onPick={(text) => onChange({ text })} />
          <LabelField value={shape.text ?? ""} onCommit={(text) => onChange({ text }, `${g}:text`)} />
          <p className={note}>{ts.pillNote}</p>
        </>
      ) : null}
      {takes("dir") ? (
        <RadioChips
          legend={ts.dirLegend}
          options={ARROW_DIRS.map((d) => ({ value: d, label: ts.dirs[d] }))}
          value={shape.dir ?? "right"}
          onChange={(d) => onChange({ dir: d })}
          columns="5.5rem"
          testId="shape-dir"
        />
      ) : null}
      {shape.kind === "progress" ? (
        <RadioChips
          legend={ts.edgeLegend}
          options={(["bottom", "top"] as ProgressEdge[]).map((e) => ({ value: e, label: ts.edges[e] }))}
          value={shape.edge ?? "bottom"}
          onChange={(e) => onChange({ edge: e })}
          columns="6rem"
          testId="shape-edge"
        />
      ) : null}
      {takes("x") ? (
        <>
          {percent(ts.x, shape.x ?? 0.5, 0, 1, "x", (v) => ({ x: v }))}
          {percent(ts.y, shape.y ?? 0.5, 0, 1, "y", (v) => ({ y: v }))}
          {percent(ts.size, shape.w ?? 0.3, 0.05, 1, "w", (v) => ({ w: v }))}
          <p className={note}>{ts.keysHint}</p>
        </>
      ) : (
        <p className={note}>{ts.progressNote}</p>
      )}
      {takes("aspect") ? (
        <SliderRow
          label={ts.aspect}
          value={shape.aspect ?? 1.6}
          min={ASPECT_MIN}
          max={ASPECT_MAX}
          step={0.05}
          text={fmt(ts.aspectValue, { v: (shape.aspect ?? 1.6).toFixed(2) })}
          onChange={(v, grp) => onChange({ aspect: v }, `${g}:aspect:${grp}`)}
        />
      ) : null}
      {takes("outline")
        ? percent(ts.outline, shape.outline ?? 0, 0, SHAPE_OUTLINE_MAX, "outline", (v) => ({ outline: v }))
        : null}
      {takes("thick") ? (
        <SliderRow
          label={ts.thick}
          value={shape.thick ?? 0.01}
          min={THICK_MIN}
          max={THICK_MAX}
          step={0.001}
          text={fmt(ts.percent, { v: ((shape.thick ?? 0.01) * 100).toFixed(1) })}
          onChange={(v, grp) => onChange({ thick: v }, `${g}:thick:${grp}`)}
        />
      ) : null}
      {percent(ts.opacity, shape.opacity, 0, 1, "opacity", (v) => ({ opacity: v }))}
      {extra}
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => onLayer(1)} disabled={n >= total} className={`${quietBtn} min-h-11`}>
            <ArrowUp className="size-3.5" aria-hidden />
            {te.overlay.forward}
          </button>
          <button type="button" onClick={() => onLayer(-1)} disabled={n <= 1} className={`${quietBtn} min-h-11`}>
            <ArrowDown className="size-3.5" aria-hidden />
            {te.overlay.backward}
          </button>
        </div>
        <p className={note}>
          {fmt(te.overlay.layer, { n, total })} {ts.layerHint}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {takes("x") ? (
          <button type="button" onClick={onReset} className={`${quietBtn} min-h-11`}>
            <RotateCcw className="size-3.5" aria-hidden />
            {ts.reset}
          </button>
        ) : null}
        <button type="button" onClick={onDelete} className={`${quietBtn} min-h-11 text-[var(--color-fail)]`}>
          <Trash2 className="size-3.5" aria-hidden />
          {ts.delete}
        </button>
      </div>
    </>
  );
}

// ── the end position of a move ──────────────────────────────────────────────

/** A shape's end keyframe: position and size only (an opacity change is the entrance / exit's job,
 *  so the per-pixel opacity budget is never touched). The bar does not move and has no section. */
export function ShapeMoveSection({
  model,
  shape,
  apply,
}: {
  model: EditorModel;
  shape: ShapeLayer;
  apply: (next: EditorModel, group?: string) => void;
}) {
  const { t } = useI18n();
  const ts = t.editor.shapes;
  if (!canMoveShape(shape)) return null;
  const end = shapeEndOf(shape);
  const labels: Record<ShapeMoveKey, string> = { x: ts.moveEndX, y: ts.moveEndY, w: ts.moveEndW };
  return (
    <Disclosure title={ts.moveTitle} active={Boolean(shape.move)} testId="shape-move-section">
      <ToggleRow
        label={ts.moveToggle}
        checked={Boolean(shape.move)}
        onChange={(on) =>
          apply(on ? startShapeMove(model, shape.id) : clearShapeMove(model, shape.id))
        }
      />
      {shape.move
        ? SHAPE_MOVE_KEYS.map((k) => {
            const same = shape.move?.to[k] === undefined;
            return (
              <SliderRow
                key={k}
                label={labels[k]}
                value={end[k]}
                min={k === "w" ? SHAPE_W_MIN : 0}
                max={k === "w" ? SHAPE_W_MAX : 1}
                step={0.01}
                text={`${fmt(ts.percent, { v: pct(end[k]) })}${same ? ` · ${ts.moveSame}` : ""}`}
                onChange={(v, g) => apply(setShapeEnd(model, shape.id, k, v), g)}
              />
            );
          })
        : null}
      <p className={note}>{ts.moveHint}</p>
    </Disclosure>
  );
}
