"use client";

/**
 * The canvas's board on React Flow (@xyflow/react, MIT): pan and zoom (wheel, pinch, Space-drag), node drag by the
 * title bar, wide-hit wires that can be selected and deleted, connection checks, and the map. What a node and a wire
 * look like is ours, the prototype's markup and classes (docs/studio/prototype), so React Flow only moves things.
 *
 * The board owns no state: the canvas (StudioCanvas) does, and keeps it in the same shape as before (nodes, wires,
 * view), which is what localStorage holds today and a studio_layouts table will hold later. Node ids are stable, so a
 * remote actor (an AI agent working through MCP, later) can be drawn on the node it is editing: `actors`.
 */
import { useCallback, useMemo, useState, type CSSProperties, type DragEvent, type ReactNode, type RefObject } from "react";
import {
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { failureReason, type StudioJob } from "@/lib/creative/studio";
import { KIND_SPEC, NODE_H, NODE_W, ZOOM_MAX, ZOOM_MIN, outputType, toCanvas, type CanvasNode, type CanvasState, type PortType, type Viewport } from "@/lib/studio/canvas";
import { ASSET_MIME, readDrop, type DroppedAsset } from "./LibraryDrawer";
import { KIND_ICONS, Lamp, statusLine } from "./parts";
import { LAMP, inputOf, nodeAsset, type JobReading, type NodeStatus } from "./nodeState";

/** Someone other than this person working on a node (an AI agent through MCP, later): a cursor, a label, a colour. */
export type RemoteActor = { id: string; label: string; colour: string };

type Previews = ReadonlyMap<string, { thumbUrl: string | null; kind: string }>;
type CardData = {
  node: CanvasNode;
  canvas: CanvasState;
  status: NodeStatus;
  name: string;
  sourceName: string | null;
  jobs: ReadonlyMap<string, JobReading>;
  previews: Previews;
  dropTarget: boolean;
  closed: boolean;
  actor: RemoteActor | null;
  onRetry: () => void;
  onOpen: () => void;
  /** The card's own small composer (QuickAdd's InlineComposer), or null. */
  composer: ReactNode;
  /** The "+" by the output: opens the next-step menu. Null on a card with no output. */
  onPlus: ((el: HTMLElement) => void) | null;
};
type WireData = { type: PortType; live: boolean; hl: boolean };
type CardNode = Node<CardData, "card">;
type WireEdge = Edge<WireData, "wire">;

/** A card carrying its own composer is wider: the composer needs a line for its words and its keys. */
const COMPOSER_W = 460;
/** The zoom below which cards switch to their one-line overview read. */
const LOD_BELOW = 0.87;
/** A press that moves less than this is a click (it opens the inspector); more is a drag (it only moves the node). */
const CLICK_SLOP = 4;

export type BoardProps = {
  boardRef: RefObject<HTMLDivElement | null>;
  canvas: CanvasState;
  setCanvas: React.Dispatch<React.SetStateAction<CanvasState>>;
  record: () => void;
  selected: string | null;
  selectedWire: string | null;
  onSelect: (id: string | null) => void;
  onSelectWire: (id: string) => void;
  onOpen: (id: string) => void;
  onRetry: (id: string) => void;
  hand: boolean;
  busy: boolean;
  statusOf: (n: CanvasNode) => NodeStatus;
  isClosed: (n: CanvasNode) => boolean;
  nodeName: (n: CanvasNode) => string;
  jobs: ReadonlyMap<string, JobReading>;
  previews: Previews;
  /** Would this wire be accepted? The typed-port rules (lib/studio/canvas canWire) and what is on sale. */
  canConnect: (from: string, to: string) => boolean;
  onWire: (from: string, to: string) => boolean;
  onDrop: (a: DroppedAsset, at: { x: number; y: number }, onto?: string) => void;
  mapOpen: boolean;
  /** The inspector is open: the focused cards sit where the map would. */
  mapHidden?: boolean;
  onToggleMap: () => void;
  /** The small composer a card carries (a card made with "+"), or null. */
  composerFor?: (n: CanvasNode) => ReactNode;
  /** "+" pressed on a card, or a wire from it dropped on empty board: open the next-step menu there. */
  onPlus?: (from: string, at: { el?: HTMLElement | null; clientX: number; clientY: number; dropped: boolean }) => void;
  /** Who else is on which node right now. Empty today; the layer for agents' cursors. */
  actors?: ReadonlyMap<string, RemoteActor>;
  children: ReactNode;
};

const NODE_TYPES = { card: CardNodeView };
const EDGE_TYPES = { wire: WireEdgeView };

export function Board(props: BoardProps) {
  return (
    <ReactFlowProvider>
      <BoardInner {...props} />
    </ReactFlowProvider>
  );
}

function BoardInner({
  boardRef,
  canvas,
  setCanvas,
  record,
  selected,
  selectedWire,
  onSelect,
  onSelectWire,
  onOpen,
  onRetry,
  hand,
  busy,
  statusOf,
  isClosed,
  nodeName,
  jobs,
  previews,
  canConnect,
  onWire,
  onDrop,
  mapOpen,
  mapHidden = false,
  onToggleMap,
  composerFor,
  onPlus,
  actors,
  children,
}: BoardProps) {
  const { t } = useI18n();
  const c = t.studioCanvas;
  const view = canvas.view;
  // React Flow measures each card; a controlled flow hands the measurement back, or the cards stay hidden.
  const [dims, setDims] = useState<Record<string, { width: number; height: number }>>({});
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const lod = view.k < LOD_BELOW;
  const nodes = useMemo<CardNode[]>(
    () =>
      canvas.nodes.map((n) => {
        const i = inputOf(canvas, n, jobs);
        return {
          id: n.id,
          type: "card",
          position: { x: n.x, y: n.y },
          // The title bar is the handle; in the overview read it is hidden, so the whole card is.
          dragHandle: lod ? undefined : ".cv-nh",
          selected: selected === n.id,
          measured: dims[n.id],
          data: {
            node: n,
            canvas,
            status: statusOf(n),
            name: nodeName(n),
            sourceName: i ? nodeName(i.from) : null,
            jobs,
            previews,
            dropTarget: dropTarget === n.id,
            closed: isClosed(n),
            actor: actors?.get(n.id) ?? null,
            onRetry: () => onRetry(n.id),
            onOpen: () => onOpen(n.id),
            composer: composerFor?.(n) ?? null,
            onPlus:
              onPlus && outputType(canvas, n)
                ? (el: HTMLElement) => {
                    const r = el.getBoundingClientRect();
                    onPlus(n.id, { el, clientX: r.right + 8, clientY: r.top, dropped: false });
                  }
                : null,
          },
        };
      }),
    [canvas, jobs, previews, selected, dims, dropTarget, statusOf, isClosed, nodeName, actors, onRetry, onOpen, lod, composerFor, onPlus],
  );

  const edges = useMemo<WireEdge[]>(() => {
    const byId = new Map(canvas.nodes.map((n) => [n.id, n]));
    return canvas.wires.flatMap((w) => {
      const a = byId.get(w.from);
      const b = byId.get(w.to);
      if (!a || !b) return [];
      return [
        {
          id: w.id,
          source: w.from,
          target: w.to,
          type: "wire" as const,
          selected: selectedWire === w.id,
          // The wide invisible path a person can actually hit.
          interactionWidth: 14,
          data: {
            type: outputType(canvas, a) ?? "image",
            // Light only from real state: a wire flows while a node on it is working.
            live: statusOf(a) === "working" || statusOf(b) === "working",
            hl: selected === w.from || selected === w.to,
          },
        },
      ];
    });
  }, [canvas, selected, selectedWire, statusOf]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CardNode>[]) => {
      const moved = new Map<string, { x: number; y: number }>();
      const sized: Record<string, { width: number; height: number }> = {};
      for (const ch of changes) {
        if (ch.type === "position" && ch.position) moved.set(ch.id, { x: Math.round(ch.position.x), y: Math.round(ch.position.y) });
        else if (ch.type === "dimensions" && ch.dimensions) sized[ch.id] = ch.dimensions;
      }
      if (moved.size) setCanvas((s) => ({ ...s, nodes: s.nodes.map((n) => (moved.has(n.id) ? { ...n, ...moved.get(n.id)! } : n)) }));
      if (Object.keys(sized).length) setDims((d) => ({ ...d, ...sized }));
    },
    [setCanvas],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<WireEdge>[]) => {
      for (const ch of changes) if (ch.type === "select" && ch.selected) onSelectWire(ch.id);
    },
    [onSelectWire],
  );

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(ASSET_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const over = (e.target as Element).closest<HTMLElement>(".react-flow__node")?.dataset.id ?? null;
    if (over !== dropTarget) setDropTarget(over);
  };
  const onDropFile = (e: DragEvent<HTMLDivElement>) => {
    const a = readDrop(e.dataTransfer.getData(ASSET_MIME));
    setDropTarget(null);
    if (!a) return;
    e.preventDefault();
    const r = boardRef.current!.getBoundingClientRect();
    const w = toCanvas(view, e.clientX - r.left, e.clientY - r.top);
    const onto = (e.target as Element).closest<HTMLElement>(".react-flow__node")?.dataset.id;
    onDrop(a, { x: w.x - NODE_W / 2, y: w.y - NODE_H / 2 }, onto);
  };

  return (
    <div
      ref={boardRef}
      // Below 87% the card's 15px text would render under 13px: the overview read takes over (the prototype's lod).
      className={`cv-stage${busy ? " is-busy" : ""}${lod ? " is-lod" : ""}`}
      data-hand={hand ? "true" : undefined}
      style={{ "--gx": `${view.x}px`, "--gy": `${view.y}px`, "--gs": `${24 * view.k}px`, "--inv": 1 / view.k } as CSSProperties}
      onDragOver={onDragOver}
      onDragLeave={() => setDropTarget(null)}
      onDrop={onDropFile}
      data-testid="canvas-board"
    >
      <ReactFlow<CardNode, WireEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={() => record()}
        onNodeClick={(e, n) => {
          // A press inside the card's own composer is the composer's, not "open the inspector".
          if ((e.target as Element).closest("button, a, input, select, textarea, .cv-ncomp")) return;
          onOpen(n.id);
        }}
        onEdgeClick={(_, ed) => onSelectWire(ed.id)}
        onPaneClick={() => onSelect(null)}
        isValidConnection={(conn) => !!conn.source && !!conn.target && canConnect(conn.source, conn.target)}
        onConnectEnd={(event, conn) => {
          // A wire dropped on empty board: offer what could come next, right there.
          if (conn.isValid || !conn.fromNode || !onPlus) return;
          const target = (event as MouseEvent).target as Element | null;
          if (!target?.closest(".react-flow__pane")) return;
          const p = "changedTouches" in event ? event.changedTouches[0] : (event as MouseEvent);
          onPlus(conn.fromNode.id, { clientX: p.clientX, clientY: p.clientY, dropped: true });
        }}
        onConnect={(conn: Connection) => {
          if (conn.source && conn.target) onWire(conn.source, conn.target);
        }}
        viewport={{ x: view.x, y: view.y, zoom: view.k }}
        onViewportChange={(v) => setCanvas((s) => ({ ...s, view: { x: v.x, y: v.y, k: v.zoom } as Viewport }))}
        minZoom={ZOOM_MIN}
        maxZoom={ZOOM_MAX}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        panOnDrag
        selectionOnDrag={false}
        nodesDraggable={!hand}
        nodesConnectable={!hand}
        elementsSelectable={!hand}
        nodeDragThreshold={CLICK_SLOP}
        nodeClickDistance={CLICK_SLOP}
        // The canvas's own keys (Delete with undo, arrows, ⌘Z) are in StudioCanvas; React Flow's would act twice.
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        disableKeyboardA11y
        connectionLineStyle={{ stroke: "var(--amber)", strokeWidth: 2, strokeDasharray: "4 6" }}
        proOptions={{ hideAttribution: true }}
        className="cv-flowboard"
      >
        {canvas.nodes.length > 0 && !mapHidden && (
          <Panel position="bottom-right" className={mapOpen ? "cv-mini" : "cv-mini is-min"}>
            <div className="cv-mini-h">
              <span>{c.map}</span>
              <button type="button" onClick={onToggleMap} aria-label={mapOpen ? c.mapMin : c.mapMax} title={mapOpen ? c.mapMin : c.mapMax} aria-expanded={mapOpen}>
                {mapOpen ? <Minus aria-hidden className="size-3.5" /> : <Plus aria-hidden className="size-3.5" />}
              </button>
            </div>
            {mapOpen && (
              <MiniMap<CardNode>
                pannable
                zoomable
                ariaLabel={c.map}
                nodeBorderRadius={2}
                nodeColor={(n) => (n.id === selected ? "var(--amber)" : n.data.status === "working" ? "var(--run)" : "var(--rule-strong)")}
                maskColor="rgb(0 0 0 / 0.28)"
                maskStrokeColor="var(--text)"
                maskStrokeWidth={1.5}
                style={{ width: 200, height: 120 }}
              />
            )}
          </Panel>
        )}
      </ReactFlow>
      {children}
    </div>
  );
}

// ── a wire: coloured by what it carries; it flows only while a node on it works ──

function WireEdgeView({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data }: EdgeProps<WireEdge>) {
  const [d] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <>
      <path d={d} className={`cv-e t-${data?.type ?? "image"}${data?.hl ? " is-hl" : ""}${selected ? " is-sel" : ""}`} data-wire={`${source}->${target}`} />
      {data?.live && <path d={d} className="cv-flowline" aria-hidden />}
      <path d={d} className="cv-hit" data-wire-hit={id} />
    </>
  );
}

// ── a node: the prototype's card ───────────────────────────────────────────────

function CardNodeView({ data, selected, dragging }: NodeProps<CardNode>) {
  return <NodeCard {...data} selected={!!selected} dragging={!!dragging} />;
}

function NodeCard({
  node,
  canvas,
  status,
  name,
  sourceName,
  selected,
  dragging,
  dropTarget,
  closed,
  actor,
  jobs,
  previews,
  onRetry,
  onOpen,
  composer,
  onPlus,
}: CardData & { selected: boolean; dragging: boolean }) {
  const { t, fmt } = useI18n();
  const c = t.studioCanvas;
  const spec = KIND_SPEC[node.kind];
  const Icon = KIND_ICONS[node.kind];
  const out = outputType(canvas, node);
  const asset = nodeAsset(node, jobs);
  const thumb = asset ? previews.get(asset)?.thumbUrl ?? null : null;
  const reading = node.jobId ? jobs.get(node.jobId) : undefined;
  const job: StudioJob | null = reading?.state === "ok" ? reading.job : null;
  const accepts = spec.accepts.map((k) => c.ports[k]).join(" / ");
  const line = statusLine(t, status, job, accepts);
  const input = inputOf(canvas, node, jobs);
  const words = node.kind === "prompt" ? node.draft : node.draft || input?.text || "";
  const working = status === "working" || status === "queued";
  const showArt = !!thumb || working || (node.kind === "asset" && status !== "missing") || status === "done";
  const cls = ["cv-node", `k-${node.kind}`, `s-${status}`, selected && "is-sel", dragging && "is-dragging", dropTarget && "is-drop", actor && "is-remote"]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={cls}
      data-node-id={node.id}
      data-kind={node.kind}
      data-status={status}
      style={{ width: composer ? COMPOSER_W : NODE_W, ...(actor ? ({ "--actor": actor.colour } as CSSProperties) : null) }}
      role="group"
      tabIndex={0}
      aria-label={`${name}: ${line}`}
      onKeyDown={(e) => {
        // The keyboard's click: Enter or Space on a focused card opens it.
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {actor && (
        <span className="cv-actor" aria-label={actor.label}>
          {actor.label}
        </span>
      )}
      <span className="cv-lodl" aria-hidden title={name}>
        <span className={`cv-lamp is-${LAMP[status]}`} />
        {name}
      </span>
      {spec.accepts.length > 0 && (
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          isConnectable={!closed}
          className={`cv-port is-in t-${spec.accepts[0]}`}
          title={fmt(c.ports.in, { kinds: accepts })}
          aria-label={fmt(c.ports.in, { kinds: accepts })}
        >
        </Handle>
      )}
      {/* The title bar is the drag handle; a press that does not move opens the inspector. */}
      <div className="cv-nh">
        <span aria-hidden className={`cv-ty k-${node.kind}`}>
          <Icon className="size-4" strokeWidth={1.9} />
        </span>
        <span className="cv-nt">
          {name !== c.kinds[node.kind].name && <span className="cv-nt-k">{c.kinds[node.kind].name}</span>}
          <span className="cv-nt-n">{name}</span>
        </span>
      </div>
      {composer ? (
        <div className="cv-nb">
          {composer}
          <Lamp tone={LAMP[status]} live={status === "working"} label={line} />
          {sourceName && <span className="cv-nsub">{fmt(c.node.from, { name: sourceName })}</span>}
        </div>
      ) : (
      <div className="cv-nb">
        {showArt && (
          <div className={`cv-art${working ? " is-working" : ""}${status === "failed" ? " is-failed" : ""}`} aria-hidden>
            {thumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumb} alt="" draggable={false} />
            ) : (
              <Icon className="cv-art-glyph" />
            )}
          </div>
        )}
        {/* The words it makes from, clamped. With none, nothing: the lamp below already says so, once. */}
        {node.kind !== "asset" && words && <p className="cv-clamp">{words}</p>}
        <Lamp tone={LAMP[status]} live={status === "working"} label={status === "failed" ? t.gen.status.failed : line} />
        {sourceName && <span className="cv-nsub">{fmt(c.node.from, { name: sourceName })}</span>}
        {status === "failed" && job && (
          <div className="cv-nfail">
            <span className="cv-nfail-why">{failureReason(t, job)}</span>
            <button type="button" className="cv-nchip nodrag" onClick={onRetry} data-testid={`retry-${node.id}`}>
              <RotateCcw aria-hidden className="size-3.5" /> {c.node.retry}
            </button>
          </div>
        )}
      </div>
      )}
      {onPlus && (
        <button
          type="button"
          className="cv-plus nodrag"
          aria-label={fmt(c.quick.add, { name })}
          title={fmt(c.quick.add, { name })}
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            onPlus(e.currentTarget);
          }}
          data-testid={`plus-${node.id}`}
        >
          <Plus aria-hidden className="size-4" />
        </button>
      )}
      {out && (
        <Handle
          type="source"
          position={Position.Right}
          id="out"
          className={`cv-port is-out t-${out}`}
          title={`${fmt(c.ports.out, { kind: c.ports[out] })} · ${c.wire.drag}`}
          aria-label={fmt(c.ports.out, { kind: c.ports[out] })}
        >
        </Handle>
      )}
    </div>
  );
}
