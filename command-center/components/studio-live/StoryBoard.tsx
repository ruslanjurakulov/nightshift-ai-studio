"use client";

/**
 * StoryBoard: the read-only board a plan is drawn on in LiveView (docs/studio/LIVE_CREATION_PLAN.md §3.8). Its cards and their
 * layout are LiveView's, moved here; what it draws is lib/studio/boardModel.ts's. (The Studio's Plan column draws the same model as
 * a storyboard grid of its own, PlanBoard.tsx.)
 *
 * Performance (§3.10): an unchanged card is the same React Flow node object between readings (boardModel reuses the LiveNode, and the
 * card's node object is cached on it here), the cards are memoised, and above VISIBLE_ONLY cards only those on screen are rendered.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { AudioLines, Clapperboard, FileText, Film, Flag, Image as ImageIcon, Lightbulb, MapPin, Music, Search, ShieldCheck, Sword, Upload, UserRound, Wand2, type LucideIcon } from "lucide-react";
import { Lamp } from "@/components/studio-canvas/parts";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import type { LiveGraph, LiveNode, LiveNodeKind, LiveStatus } from "@/lib/studio/liveGraph";

export const ICONS: Record<LiveNodeKind, LucideIcon> = {
  idea: Lightbulb,
  script: FileText,
  keyframe: ImageIcon,
  clip: Clapperboard,
  voice: AudioLines,
  music: Music,
  assembly: Wand2,
  final: Film,
  character: UserRound,
  location: MapPin,
  prop: Sword,
  topic: Flag,
  research: Search,
  visuals: ImageIcon,
  render: Clapperboard,
  gate: ShieldCheck,
  upload: Upload,
};

export const TONE: Record<LiveStatus, "ok" | "run" | "fail" | "warn" | "idle"> = {
  draft: "idle",
  waiting: "idle",
  // Its first attempt failed; the retry has not begun: not fine, not running.
  retried: "warn",
  working: "run",
  done: "ok",
  failed: "fail",
  skipped: "idle",
  stopped: "warn",
  unknown: "warn",
  none: "idle",
};

/** The board only where it can be read (S4 HIGH 2: at 768 the fitted plan was ~5px text): a list below 1280. */
const NARROW = "(max-width: 1279px)";
const FIT = { padding: 0.12, minZoom: 0.72, maxZoom: 1 };
export const reduced = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Refit when the board resizes (the details panel opening narrows it), and keep the selected step on screen: the whole plan may not
 * fit at a readable zoom (FIT.minZoom), so after the fit the view pans until the chosen card is inside the board (Pixel H3).
 */
function FitOnResize({ selected }: { selected: string | null }) {
  const { fitView, getInternalNode, getViewport, setViewport } = useReactFlow();
  const ref = useRef<HTMLDivElement>(null);
  const sel = useRef(selected);
  sel.current = selected;
  const keep = useCallback(() => {
    const board = ref.current?.closest(".lv-board");
    const id = sel.current;
    const n = id ? getInternalNode(id) : undefined;
    if (!board || !n) return;
    const { x, y, zoom } = getViewport();
    const w = (n.measured.width ?? 200) * zoom;
    const left = n.internals.positionAbsolute.x * zoom + x;
    const hgt = (n.measured.height ?? 76) * zoom;
    const top = n.internals.positionAbsolute.y * zoom + y;
    const pad = 24;
    const fit = (pos: number, size: number, room: number, at: number) => {
      let next = at;
      if (pos + size > room - pad) next = at - (pos + size - (room - pad));
      if (pos + (next - at) < pad) next = at + (pad - pos);
      return next;
    };
    const nx = fit(left, w, board.clientWidth, x);
    const ny = fit(top, hgt, board.clientHeight, y);
    if (nx !== x || ny !== y) void setViewport({ x: nx, y: ny, zoom }, { duration: reduced() ? 0 : 200 });
  }, [getInternalNode, getViewport, setViewport]);
  useEffect(() => {
    const el = ref.current?.closest(".lv-board");
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => void Promise.resolve(fitView({ ...FIT, duration: reduced() ? 0 : 200 })).then(() => setTimeout(keep, reduced() ? 0 : 220)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitView, keep]);
  useEffect(() => keep(), [selected, keep]);
  return <div ref={ref} hidden />;
}
const COL_W = 236;
const ROW_H = 124;

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(NARROW);
    setNarrow(m.matches);
    const on = () => setNarrow(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return narrow;
}

type CardData = { node: LiveNode; name: string; statusWord: string; price: string | null; lit: boolean; selected: boolean; onOpen: (id: string) => void };


const CardView = memo(function CardView({ data }: NodeProps<Node<CardData, "step">>) {
  const Icon = ICONS[data.node.kind];
  return (
    <>
      <Handle type="target" position={Position.Left} className="lv-handle" isConnectable={false} />
      <button
        type="button"
        className={`lv-card is-${data.node.status}${data.selected ? " is-selected" : ""}`}
        data-testid={`live-node-${data.node.id}`}
        data-node-id={data.node.id}
        data-status={data.node.status}
        data-lit={data.lit ? "" : undefined}
        aria-pressed={data.selected}
        onClick={() => data.onOpen(data.node.id)}
      >
        <span className="lv-card-head">
          <Icon aria-hidden className="size-4" />
          <span className="lv-card-name">{data.name}</span>
        </span>
        <Lamp tone={TONE[data.node.status]} live={data.node.status === "working"} label={data.statusWord} />
        {data.price ? <span className="lv-price">{data.price}</span> : null}
      </button>
      <Handle type="source" position={Position.Right} className="lv-handle" isConnectable={false} />
    </>
  );
});

const NODE_TYPES = { step: CardView };

export type ViewProps = {
  graph: LiveGraph;
  selected: string | null;
  onOpen: (id: string) => void;
  names: Map<string, string>;
  words: Map<string, string>;
  prices: Map<string, string>;
  lit: ReadonlySet<string>;
  /**
   * Render only the cards on screen above VISIBLE_ONLY cards. Off where a card must exist off screen: the Live lane's flights start
   * from a card's box (LiveView turns it off while the lane is mounted), and a keyboard must reach every card.
   */
  visibleOnly?: boolean;
};

/** A wire that fans out of the script into each scene, or into the assembly from each scene: drawn as right angles, not a bundle. */
const fan = (from: string, to: string) => (from === "script" && to.startsWith("scene#")) || (to === "assembly" && from.startsWith("scene#"));


/** Above this many cards React Flow renders only the ones on screen (a 50-scene storyboard is ~110 cards). */
export const VISIBLE_ONLY = 40;

type FlowNode = Node<CardData, "step">;
const sameCard = (a: CardData, b: CardData) =>
  a.node === b.node && a.name === b.name && a.statusWord === b.statusWord && a.price === b.price && a.lit === b.lit && a.selected === b.selected &&
  a.onOpen === b.onOpen;

export function Board({ graph, selected, onOpen, names, words, prices, lit, visibleOnly = false }: ViewProps) {
  // The node object React Flow was given for each card last time: handed back as it was when nothing on the card changed.
  const cache = useRef(new Map<string, FlowNode>());
  const nodes = useMemo<FlowNode[]>(() => {
    const next = new Map<string, FlowNode>();
    const list = graph.nodes.map((n) => {
      const data: CardData = { node: n, name: names.get(n.id) ?? n.id, statusWord: words.get(n.id) ?? "", price: prices.get(n.id) ?? null, lit: lit.has(n.id), selected: selected === n.id, onOpen };
      const old = cache.current.get(n.id);
      const node: FlowNode =
        old && old.position.x === n.col * COL_W && old.position.y === n.row * ROW_H && sameCard(old.data, data)
          ? old
          : { id: n.id, type: "step", position: { x: n.col * COL_W, y: n.row * ROW_H }, data, draggable: false, connectable: false, selectable: false };
      next.set(n.id, node);
      return node;
    });
    cache.current = next;
    return list;
  }, [graph, selected, onOpen, names, words, prices, lit]);
  const status = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.status])), [graph]);
  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((e) => ({
        id: `${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        ...(fan(e.from, e.to) ? { type: "smoothstep", pathOptions: { borderRadius: 8 } } : {}),
        // A step not in the plan draws no live path into the next one (S4 LOW 6).
        className:
          status.get(e.from) === "none" || status.get(e.to) === "none"
            ? "lv-edge is-none"
            : status.get(e.from) === "done" && status.get(e.to) === "working"
              ? "lv-edge is-live"
              : status.get(e.from) === "done"
                ? "lv-edge is-done"
                : "lv-edge",
        selectable: false,
        focusable: false,
      })),
    [graph, status],
  );
  return (
    <div className="lv-board" data-testid="live-board">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          nodesFocusable={false}
          // A read-only board: React Flow's own "arrow keys move the node, delete removes it" would be a false instruction.
          disableKeyboardA11y
          fitView
          fitViewOptions={FIT}
          minZoom={0.3}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
          onlyRenderVisibleElements={visibleOnly && nodes.length > VISIBLE_ONLY}
        >
          <FitOnResize selected={selected} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

const ListCard = memo(function ListCard({ node: n, name, word, price, lit, selected, onOpen }: {
  node: LiveNode; name: string; word: string; price: string | null; lit: boolean; selected: boolean; onOpen: (id: string) => void;
}) {
  const Icon = ICONS[n.kind];
  return (
    <li>
      <button
        type="button"
        className={`lv-card is-${n.status}${selected ? " is-selected" : ""}`}
        data-testid={`live-node-${n.id}`}
        data-node-id={n.id}
        data-status={n.status}
        data-lit={lit ? "" : undefined}
        aria-pressed={selected}
        onClick={() => onOpen(n.id)}
      >
        <span className="lv-card-head">
          <Icon aria-hidden className="size-4" />
          <span className="lv-card-name">{name}</span>
        </span>
        <Lamp tone={TONE[n.status]} live={n.status === "working"} label={word} />
        {price ? <span className="lv-price">{price}</span> : null}
      </button>
    </li>
  );
});

export function List({ graph, selected, onOpen, names, words, prices, lit }: ViewProps) {
  // A scene reads as its picture then its clip (Pixel M5): the scene columns (2 and 3) are ordered by row first.
  const group = (n: LiveNode) => (n.col < 2 ? 0 : n.col <= 3 ? 1 : 2);
  const order = [...graph.nodes].sort((a, b) => group(a) - group(b) || (group(a) === 1 ? a.row - b.row || a.col - b.col : a.col - b.col || a.row - b.row));
  return (
    <ol className="lv-list" data-testid="live-list">
      {order.map((n) => (
        <ListCard
          key={n.id}
          node={n}
          name={names.get(n.id) ?? ""}
          word={words.get(n.id) ?? ""}
          price={prices.get(n.id) ?? null}
          lit={lit.has(n.id)}
          selected={selected === n.id}
          onOpen={onOpen}
        />
      ))}
    </ol>
  );
}

type T = ReturnType<typeof useI18n>["t"];

/** A card's name: its kind ("Scene 3 · picture"), and for a character, place or prop the brief's name for it. */
export function nodeName(t: T, n: LiveNode): string {
  const kind = fmt(t.studioLive.kinds[n.kind], { n: n.scene ?? "" });
  return (n.kind === "character" || n.kind === "location" || n.kind === "prop") && n.sceneTitle ? `${kind} · ${n.sceneTitle}` : kind;
}

/** The board as a person reads it: names, status words and the backend's prices; a list below 1280 px, the board above. */
export function StoryBoard({
  graph,
  selected,
  onOpen,
  lit,
  visibleOnly,
}: Pick<ViewProps, "graph" | "selected" | "onOpen" | "lit" | "visibleOnly">) {
  const { t } = useI18n();
  const c = t.studioLive;
  const narrow = useNarrow();
  const names = useMemo(() => new Map(graph.nodes.map((n) => [n.id, nodeName(t, n)])), [graph, t]);
  const words = useMemo(() => new Map(graph.nodes.map((n) => [n.id, c.status[n.status]])), [graph, c]);
  const prices = useMemo(
    () => new Map(graph.nodes.filter((n) => typeof n.price === "number").map((n) => [n.id, fmt(c.price, { n: n.price as number })])),
    [graph, c],
  );
  const props = { graph, selected, onOpen, names, words, prices, lit, visibleOnly };
  return narrow ? <List {...props} /> : <Board {...props} />;
}
