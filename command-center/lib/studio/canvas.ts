/**
 * Nightshift Studio's canvas (docs/studio/STUDIO_IA.md §2, the `sketch` project): the pure model.
 *
 * Every tool is a node; a wire is a real input — an Image node's picture wired into an Image → Video
 * node becomes that clip's source in its form. Nothing here prices, spends or fetches: a node only
 * ever reaches money through the existing composer (components/studio/GeneratePanel) and its quote.
 *
 * Pure and client-safe: no React, no window (the storage helpers take the storage to use), so
 * tests/studio-canvas.test.ts can hold every rule.
 */
import type { MediaDesk } from "@/lib/creative/desks";
import type { StudioCapability } from "@/lib/creative/studio";

// ── nodes ──────────────────────────────────────────────────────────────────────

/** What travels on a wire. A port's kind is told apart by shape and a letter, never by colour alone (IA §3). */
export type PortType = "text" | "image" | "video" | "audio";

export const NODE_KINDS = ["prompt", "image", "video", "animate", "effects", "enhance", "voice", "asset"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
/** The kinds a person adds from "Add node" (an asset node comes from the Library drawer). */
export const TOOL_KINDS = ["prompt", "image", "video", "animate", "effects", "enhance", "voice"] as const satisfies readonly NodeKind[];
export type ToolKind = (typeof TOOL_KINDS)[number];

export interface KindSpec {
  /** The composer desk the inspector opens (lib/creative/desks): its tools only. */
  desk: MediaDesk | null;
  /** The tool the node's form starts on. */
  capability: StudioCapability | null;
  /** What its one input port takes; empty = no input port. */
  accepts: readonly PortType[];
  /** Whether a quote cannot happen without that input (rule 6: say so on the node before any quote). */
  required: boolean;
  /** What comes out; null = the same kind as what came in (Edit · Upscale) or the file's own kind (an asset). */
  out: PortType | null;
}

export const KIND_SPEC: Record<NodeKind, KindSpec> = {
  // Words, typed once: wired into an Image, Video or Voice node they fill its form's words. Free: it is text.
  prompt: { desk: null, capability: null, accepts: [], required: false, out: "text" },
  image: { desk: "image", capability: "t2i", accepts: ["text"], required: false, out: "image" },
  video: { desk: "video", capability: "t2v", accepts: ["text"], required: false, out: "video" },
  animate: { desk: "video", capability: "i2v", accepts: ["image"], required: true, out: "video" },
  // An effect is a Video-desk form filled with its words; a picture effect takes one picture.
  effects: { desk: "video", capability: "t2v", accepts: ["image"], required: false, out: "video" },
  enhance: { desk: "enhance", capability: "upscale", accepts: ["image", "video"], required: true, out: null },
  // Voice-over starts from words; a voice change or a dub takes a recording.
  voice: { desk: "voice", capability: "tts", accepts: ["text", "audio", "video"], required: false, out: "audio" },
  asset: { desk: null, capability: null, accepts: [], required: false, out: null },
};

export function isNodeKind(v: unknown): v is NodeKind {
  return typeof v === "string" && (NODE_KINDS as readonly string[]).includes(v);
}

export interface CanvasNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  /** The generation this node started (creative_jobs.id), once its priced press went through. */
  jobId: string | null;
  /** An asset node's library file (media_assets.id). */
  assetId: string | null;
  /** An asset node's file kind, as the library said when it was dropped. */
  assetKind: PortType | null;
  /** The words typed in the node's form, so switching nodes never loses them. */
  draft: string;
  /** An Effects node's chosen effect (lib/effects/catalog.ts id). */
  effectId: string | null;
}

export interface CanvasWire {
  id: string;
  from: string;
  to: string;
}

export interface Viewport {
  x: number;
  y: number;
  k: number;
}

export interface CanvasState {
  nodes: CanvasNode[];
  wires: CanvasWire[];
  view: Viewport;
}

/** Drawn size of a node card: fixed, so ports and wires line up without measuring the DOM. */
export const NODE_W = 240;
/** A card's height for layout maths (bounds, fit, Tidy), at its tallest everyday height (title, 16:9 art, three lines of words, its lamp and its source), so Tidy never stacks one card into the next. */
export const NODE_H = 300;
/** Where the ports sit: level with the card's title bar, so a wire meets a card at the same place whatever its body holds. */
export const PORT_Y = 25;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;

export const EMPTY_STATE: CanvasState = { nodes: [], wires: [], view: { x: 0, y: 0, k: 1 } };

export function newNode(kind: NodeKind, x: number, y: number, id: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return { id, kind, x: Math.round(x), y: Math.round(y), jobId: null, assetId: null, assetKind: null, draft: "", effectId: null, ...extra };
}

// ── wires ──────────────────────────────────────────────────────────────────────

/** The wire into a node's input port, if any (one input port per node). */
export function wireInto(state: Pick<CanvasState, "wires">, nodeId: string): CanvasWire | null {
  return state.wires.find((w) => w.to === nodeId) ?? null;
}

/**
 * What a node puts out. Edit · Upscale passes through what it was given; an asset is its file's kind;
 * a node whose output kind cannot be known (an unwired Edit) says null, and nothing can be wired from it.
 */
export function outputType(state: Pick<CanvasState, "nodes" | "wires">, node: CanvasNode, seen: ReadonlySet<string> = new Set()): PortType | null {
  if (node.kind === "asset") return node.assetKind;
  const spec = KIND_SPEC[node.kind];
  if (spec.out) return spec.out;
  if (seen.has(node.id)) return null;
  const into = wireInto(state, node.id);
  const src = into ? state.nodes.find((n) => n.id === into.from) : undefined;
  return src ? outputType(state, src, new Set([...seen, node.id])) : null;
}

/** Would a wire from `from` to `to` close a loop? */
function reaches(state: Pick<CanvasState, "wires">, start: string, target: string): boolean {
  const stack = [start];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const w of state.wires) if (w.from === id) stack.push(w.to);
  }
  return false;
}

export type WireRefusal = "same_node" | "no_input" | "wrong_type" | "loop" | "unknown_node" | "no_output";

/** Can `from`'s output go into `to`'s input? A refusal names why, so the canvas can say it in words. */
export function canWire(state: Pick<CanvasState, "nodes" | "wires">, from: string, to: string): { ok: true; type: PortType } | { ok: false; why: WireRefusal } {
  if (from === to) return { ok: false, why: "same_node" };
  const a = state.nodes.find((n) => n.id === from);
  const b = state.nodes.find((n) => n.id === to);
  if (!a || !b) return { ok: false, why: "unknown_node" };
  const accepts = KIND_SPEC[b.kind].accepts;
  if (accepts.length === 0) return { ok: false, why: "no_input" };
  const type = outputType(state, a);
  if (!type) return { ok: false, why: "no_output" };
  if (!accepts.includes(type)) return { ok: false, why: "wrong_type" };
  if (reaches(state, to, from)) return { ok: false, why: "loop" };
  return { ok: true, type };
}

/** Wire `from` into `to`, replacing whatever fed that input before (one input per node). */
export function connect(state: CanvasState, from: string, to: string, id: string): CanvasState {
  if (!canWire(state, from, to).ok) return state;
  return { ...state, wires: [...state.wires.filter((w) => w.to !== to), { id, from, to }] };
}

export function disconnect(state: CanvasState, to: string): CanvasState {
  return { ...state, wires: state.wires.filter((w) => w.to !== to) };
}

export function removeNode(state: CanvasState, id: string): CanvasState {
  return { ...state, nodes: state.nodes.filter((n) => n.id !== id), wires: state.wires.filter((w) => w.from !== id && w.to !== id) };
}

/** A required input with nothing wired in (rule 6: the node says so before any quote). */
export function missingInput(state: Pick<CanvasState, "wires">, node: CanvasNode): boolean {
  return KIND_SPEC[node.kind].required && !wireInto(state, node.id);
}

// ── order and layout ───────────────────────────────────────────────────────────

/** How many wires stand between a node and a source (a node with no input is 0). Loops cannot exist (canWire). */
export function depthOf(state: Pick<CanvasState, "wires">, id: string, seen: ReadonlySet<string> = new Set()): number {
  const into = wireInto(state, id);
  if (!into || seen.has(id)) return 0;
  return 1 + depthOf(state, into.from, new Set([...seen, id]));
}

/** Graph order: sources first, then what they feed — the phone's vertical flow and Tidy both read it. Stable by position. */
export function flowOrder(state: Pick<CanvasState, "nodes" | "wires">): CanvasNode[] {
  return [...state.nodes].sort((a, b) => depthOf(state, a.id) - depthOf(state, b.id) || a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
}

const GAP_X = 96;
const GAP_Y = 56;

/** Tidy: one column per depth, left to right, keeping each column's top-to-bottom order. Moves nothing else. */
export function tidy(state: CanvasState): CanvasState {
  const columns = new Map<number, CanvasNode[]>();
  for (const n of flowOrder(state)) {
    const d = depthOf(state, n.id);
    columns.set(d, [...(columns.get(d) ?? []), n]);
  }
  const placed = new Map<string, { x: number; y: number }>();
  for (const [d, list] of columns) list.forEach((n, i) => placed.set(n.id, { x: d * (NODE_W + GAP_X), y: i * (NODE_H + GAP_Y) }));
  return { ...state, nodes: state.nodes.map((n) => ({ ...n, ...placed.get(n.id)! })) };
}

/** A free spot for a new node: right of everything, level with the top. */
export function nextSpot(nodes: readonly CanvasNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 0, y: 0 };
  const b = bounds(nodes)!;
  return { x: b.maxX + GAP_X, y: b.minY };
}

// ── viewport ───────────────────────────────────────────────────────────────────

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bounds(nodes: readonly Pick<CanvasNode, "x" | "y">[]): Bounds | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NODE_W);
    maxY = Math.max(maxY, n.y + NODE_H);
  }
  return { minX, minY, maxX, maxY };
}

export const clampZoom = (k: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number.isFinite(k) ? k : 1));

/** Zoom to `k` keeping the canvas point under (cx, cy) — the cursor or the pinch centre — where it is on screen. */
export function zoomAt(view: Viewport, k: number, cx: number, cy: number): Viewport {
  const next = clampZoom(k);
  const wx = (cx - view.x) / view.k;
  const wy = (cy - view.y) / view.k;
  return { k: next, x: cx - wx * next, y: cy - wy * next };
}

/** The view that shows every node with a margin, never zoomed past 1 (a single node is not blown up). */
export function fitView(nodes: readonly Pick<CanvasNode, "x" | "y">[], width: number, height: number, pad = 64): Viewport {
  const b = bounds(nodes);
  if (!b || width <= 0 || height <= 0) return { x: width / 2 - NODE_W / 2, y: height / 2 - NODE_H / 2, k: 1 };
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const k = clampZoom(Math.min(1, (width - pad * 2) / w, (height - pad * 2) / h));
  return { k, x: (width - w * k) / 2 - b.minX * k, y: (height - h * k) / 2 - b.minY * k };
}

/** Screen → canvas coordinates. */
export function toCanvas(view: Viewport, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - view.x) / view.k, y: (sy - view.y) / view.k };
}

/** A wire's path between an output port (right edge) and an input port (left edge): a calm horizontal S. */
export function wirePath(a: Pick<CanvasNode, "x" | "y">, b: Pick<CanvasNode, "x" | "y">): string {
  const x1 = a.x + NODE_W;
  const y1 = a.y + PORT_Y;
  const x2 = b.x;
  const y2 = b.y + PORT_Y;
  const c = Math.max(48, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}`;
}

// ── starter recipes (free: they lay out nodes and wires, nothing else) ────────────

export const RECIPES = ["photoClip", "promptVideo", "promptVoice"] as const;
export type Recipe = (typeof RECIPES)[number];

const STEP = NODE_W + GAP_X;

/** Real chains, as the prototype's starters: words → picture → clip, a library picture → clip, words → voice. */
export function recipeState(recipe: Recipe, makeId: () => string, words = ""): CanvasState {
  if (recipe === "photoClip") {
    // The picture comes from the Library (the drawer opens): the clip node shows its missing input until then.
    const clip = newNode("animate", STEP, 0, makeId());
    return { ...EMPTY_STATE, nodes: [clip] };
  }
  const prompt = newNode("prompt", 0, 0, makeId(), { draft: words });
  if (recipe === "promptVideo") {
    const image = newNode("image", STEP, 0, makeId());
    const clip = newNode("animate", STEP * 2, 0, makeId());
    return {
      ...EMPTY_STATE,
      nodes: [prompt, image, clip],
      wires: [
        { id: makeId(), from: prompt.id, to: image.id },
        { id: makeId(), from: image.id, to: clip.id },
      ],
    };
  }
  const voice = newNode("voice", STEP, 0, makeId());
  return { ...EMPTY_STATE, nodes: [prompt, voice], wires: [{ id: makeId(), from: prompt.id, to: voice.id }] };
}

// ── persistence: this browser only, until a studio_layouts table exists ────────────

/** One layout per organization, channel and person: two people never see each other's sketch. */
export function layoutKey(orgId: string, channel: string, userId: string): string {
  return `ns.studio.canvas.v1:${orgId}:${channel}:${userId}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NODE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const EFFECT_ID = /^[a-z0-9_-]{1,60}$/;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e6;
const MAX_NODES = 200;
const DRAFT_MAX = 4000;

/**
 * A stored layout, checked field by field: anything malformed (another version, a hand-edited value, a
 * different person's shape) is dropped rather than trusted, and a layout that cannot be read at all is
 * an empty canvas — never an error and never a half-drawn graph.
 */
export function parseLayout(raw: unknown): CanvasState {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return EMPTY_STATE;
    }
  }
  if (!v || typeof v !== "object") return EMPTY_STATE;
  const o = v as Record<string, unknown>;
  const nodes: CanvasNode[] = [];
  for (const r of Array.isArray(o.nodes) ? o.nodes.slice(0, MAX_NODES) : []) {
    if (!r || typeof r !== "object") continue;
    const n = r as Record<string, unknown>;
    if (typeof n.id !== "string" || !NODE_ID.test(n.id) || !isNodeKind(n.kind) || !finite(n.x) || !finite(n.y)) continue;
    if (nodes.some((m) => m.id === n.id)) continue;
    const assetId = typeof n.assetId === "string" && UUID.test(n.assetId) ? n.assetId : null;
    if (n.kind === "asset" && !assetId) continue;
    const assetKind = n.assetKind === "image" || n.assetKind === "video" || n.assetKind === "audio" ? n.assetKind : null;
    nodes.push(
      newNode(n.kind, n.x, n.y, n.id, {
        jobId: typeof n.jobId === "string" && UUID.test(n.jobId) ? n.jobId : null,
        assetId: n.kind === "asset" ? assetId : null,
        assetKind: n.kind === "asset" ? assetKind : null,
        draft: typeof n.draft === "string" ? n.draft.slice(0, DRAFT_MAX) : "",
        effectId: n.kind === "effects" && typeof n.effectId === "string" && EFFECT_ID.test(n.effectId) ? n.effectId : null,
      }),
    );
  }
  let state: CanvasState = { nodes, wires: [], view: { x: 0, y: 0, k: 1 } };
  for (const r of Array.isArray(o.wires) ? o.wires : []) {
    if (!r || typeof r !== "object") continue;
    const w = r as Record<string, unknown>;
    if (typeof w.id !== "string" || !NODE_ID.test(w.id) || typeof w.from !== "string" || typeof w.to !== "string") continue;
    // The same rules as drawing one: a stored wire that could not be drawn now is not restored.
    state = connect(state, w.from, w.to, w.id);
  }
  const view = o.view as Record<string, unknown> | undefined;
  if (view && finite(view.x) && finite(view.y) && finite(view.k)) state = { ...state, view: { x: view.x, y: view.y, k: clampZoom(view.k) } };
  return state;
}

type KV = Pick<Storage, "getItem" | "setItem">;

/** Read a layout; storage that is blocked, missing or full reads as an empty canvas. */
export function loadLayout(storage: KV | null, key: string): CanvasState {
  try {
    return storage ? parseLayout(storage.getItem(key)) : EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
}

/** Save a layout; a refusal (private window, quota) is swallowed: the canvas keeps working, it is just not remembered. */
export function saveLayout(storage: KV | null, key: string, state: CanvasState): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify({ v: 1, nodes: state.nodes, wires: state.wires, view: state.view }));
    return true;
  } catch {
    return false;
  }
}
