"use client";

/**
 * The Studio's Plan column drawn as a storyboard (lib/studio/planGrid.ts): one card per scene, wrapped to the board's width at zoom 1,
 * scrolling down for a longer plan, never shrunk to fit (Pixel H3). React Flow carries the board (Controls to fit or zoom, the same
 * pan and wheel as the Studio's other boards); the cards are S5's (PlanSceneCard until <LiveNode> lands).
 *
 * Every card is rendered, never only the visible ones: a keyboard reaches every card by Tab, and a focused card is brought into view
 * (Pixel H1). The card's title button is the tab stop; React Flow's own node focus is off.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent } from "react";
import { Controls, ReactFlow, ReactFlowProvider, useReactFlow, useStore, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { cardState, planLayout, type PlanItems } from "@/lib/studio/planGrid";
import type { LiveNode } from "@/lib/studio/liveGraph";
import { PlanSceneCard, type LiveNodeProps } from "./PlanSceneCard";
import { nodeName, reduced } from "./StoryBoard";

type T = ReturnType<typeof useI18n>["t"];

/** Room kept at the board's right edge for React Flow's Controls (44 px keys and their inset). */
export const CONTROLS_GUTTER = 60;
const EDGE = 12;
/** The viewport y that shows a card wholly (`top`, `h` in screen pixels at y = 0), moving as little as possible. */
export function scrollInto(top: number, h: number, room: number, y: number): number {
  const at = top + y;
  if (at < EDGE) return y + (EDGE - at);
  if (at + h > room - EDGE) return y - (at + h - (room - EDGE));
  return y;
}
type CardNode = Node<{ card: LiveNodeProps; w: number }, "plan">;

const CardNodeView = memo(function CardNodeView({ data }: NodeProps<CardNode>) {
  return (
    <div className="plan-node" style={{ width: data.w, "--live-node-w": `${data.w}px` } as CSSProperties}>
      <PlanSceneCard {...data.card} />
    </div>
  );
});
const NODE_TYPES = { plan: CardNodeView };

/** The props of every card, in reading order: the one list both the board and the phone's list draw. */
export function planCards(
  t: T,
  items: PlanItems,
  opts: { selected: string | null; onOpen: (id: string) => void; enter: ReadonlyMap<string, number>; reasons?: (n: LiveNode) => string | null },
): LiveNodeProps[] {
  const step = (n: LiveNode): LiveNodeProps => ({
    id: n.id,
    kind: n.kind,
    state: cardState(n),
    title: nodeName(t, n),
    // The idea's words, the script's first line: what this card stands for, not a status word.
    summary: n.kind === "idea" || n.kind === "script" || n.kind === "topic" ? (n.text?.split(/\r?\n/).find((l) => l.trim())?.trim() ?? null) : null,
    selected: opts.selected === n.id,
    onOpen: opts.onOpen,
    order: opts.enter.get(n.id),
    reason: opts.reasons?.(n) ?? null,
    headingLevel: 3,
  });
  return [
    ...items.top.map(step),
    ...items.scenes.map<LiveNodeProps>((s) => ({
      id: s.id,
      kind: "scene",
      scene: s.n,
      state: cardState(s.keyframe),
      title: s.title ?? fmt(t.studioLive.plan.card.scene, { n: s.n }),
      summary: s.summary,
      durationS: s.seconds,
      durationBasis: s.seconds ? "planned" : undefined,
      cast: s.cast.map((n) => n || t.studioLive.plan.card.unnamed),
      selected: opts.selected === s.keyframe.id || (!!s.clip && opts.selected === s.clip.id),
      onOpen: opts.onOpen,
      order: opts.enter.get(s.id),
      headingLevel: 3,
    })),
    ...items.footer.map(step),
  ];
}

function Inner({ cards, items, width, height }: { cards: LiveNodeProps[]; items: PlanItems; width: number; height: number }) {
  const { t } = useI18n();
  const w = t.studioLive.plan.controls;
  const { setViewport, getViewport } = useReactFlow();
  // React Flow's measured card heights, so a taller card (a longer title, S5's card) widens its row instead of overlapping the next.
  const heightsKey = useStore((s) => {
    let k = "";
    for (const [id, n] of s.nodeLookup) if (n.measured.height) k += `${id}=${Math.ceil(n.measured.height)};`;
    return k;
  });
  const measured = useMemo(() => {
    const m = new Map<string, number>();
    for (const part of heightsKey.split(";")) {
      const i = part.lastIndexOf("=");
      if (i > 0) m.set(part.slice(0, i), Number(part.slice(i + 1)));
    }
    return m;
  }, [heightsKey]);
  // The Controls sit at the board's bottom right: the grid keeps a gutter for them, so no card ever runs under a key (Pixel b).
  const layout = useMemo(() => planLayout(items, Math.max(0, width - CONTROLS_GUTTER), measured), [items, width, measured]);
  // Centred in the room left of the controls' gutter: the leftover is split, not left on one side.
  const dx = Math.max(0, Math.floor((width - CONTROLS_GUTTER - layout.width) / 2));
  const place = useMemo(() => new Map(layout.placed.map((p) => [p.id, p])), [layout]);
  const cache = useRef(new Map<string, CardNode>());
  const nodes = useMemo<CardNode[]>(() => {
    const next = new Map<string, CardNode>();
    const list = cards.flatMap((card) => {
      const p = place.get(card.id);
      if (!p) return [];
      const old = cache.current.get(card.id);
      const same = old && old.position.x === p.x + dx && old.position.y === p.y && old.data.w === p.w && sameCard(old.data.card, card);
      const node: CardNode = same && old ? old : { id: card.id, type: "plan", position: { x: p.x + dx, y: p.y }, data: { card, w: p.w }, draggable: false, connectable: false, selectable: false, focusable: false };
      next.set(card.id, node);
      return [node];
    });
    cache.current = next;
    return list;
  }, [cards, place, dx]);
  // The two wires that read left to right in a row: the idea into the script, the assembly into the final video. The scenes are read
  // in order in the grid itself; a wire from the script into each of them was a bundle with nowhere to go (Pixel H2).
  const edges = useMemo<Edge[]>(() => {
    const ids = new Set(nodes.map((n) => n.id));
    return (
      [
        ["idea", "script"],
        ["assembly", "final"],
      ] as const
    )
      .filter(([a, b]) => ids.has(a) && ids.has(b))
      .map(([a, b]) => ({ id: `${a}->${b}`, source: a, target: b, className: "lv-edge", selectable: false, focusable: false }));
  }, [nodes]);

  // A card that takes focus is brought wholly into view: Tab reaches every card, not only the ones already on screen.
  const onFocus = useCallback(
    (e: FocusEvent<HTMLDivElement>) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
      const p = id ? place.get(id) : undefined;
      if (!p) return;
      // Up or down only, by as little as brings the card wholly into view: the grid already fits the width, so a sideways pan or a
      // zoom on Tab would only move the plan under the person's eyes (Pixel N1).
      const { x, y, zoom } = getViewport();
      const ny = scrollInto(p.y * zoom, p.h * zoom, height, y);
      if (ny !== y) void setViewport({ x, y: ny, zoom }, { duration: reduced() ? 0 : 200 });
    },
    [place, getViewport, setViewport, height],
  );
  const extentH = Math.max(layout.height, height);
  return (
    <div className="plan-flow" onFocus={onFocus}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        disableKeyboardA11y
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        minZoom={0.4}
        maxZoom={1.5}
        // A longer plan scrolls down, like a page: the wheel moves it, it never zooms it below a readable size by itself.
        panOnScroll
        panOnScrollMode={"vertical" as never}
        zoomOnScroll={false}
        translateExtent={[
          [0, 0],
          [Math.max(width, layout.width + dx), extentH],
        ]}
        proOptions={{ hideAttribution: true }}
        ariaLabelConfig={{
          "controls.ariaLabel": w.label,
          "controls.zoomIn.ariaLabel": w.zoomIn,
          "controls.zoomOut.ariaLabel": w.zoomOut,
          "controls.fitView.ariaLabel": w.fit,
        }}
      >
        <Controls showInteractive={false} position="bottom-right" className="plan-controls" fitViewOptions={{ padding: 0.04, maxZoom: 1 }} />
      </ReactFlow>
    </div>
  );
}

function sameCard(a: LiveNodeProps, b: LiveNodeProps): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof LiveNodeProps>;
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    if (Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => v === y[i])) continue;
    return false;
  }
  return true;
}

export function PlanBoard({ cards, items }: { cards: LiveNodeProps[]; items: PlanItems }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="lv-board plan-board" data-testid="plan-board">
      {size.w > 0 ? (
        <ReactFlowProvider>
          <Inner cards={cards} items={items} width={size.w} height={size.h} />
        </ReactFlowProvider>
      ) : null}
    </div>
  );
}

/** At phone width: the same cards as a list, one row per scene, in reading order. */
export function PlanList({ cards }: { cards: LiveNodeProps[] }) {
  return (
    <ol className="plan-list" data-testid="plan-list">
      {cards.map((c) => (
        <li key={c.id}>
          <PlanSceneCard {...c} />
        </li>
      ))}
    </ol>
  );
}
