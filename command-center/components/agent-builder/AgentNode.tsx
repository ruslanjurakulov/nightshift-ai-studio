"use client";

/**
 * A node card and a wire on the Agent Builder's React Flow canvas.
 *
 * The card's layout follows the node UI patterns of Tersa (https://github.com/vercel-labs/tersa, MIT, Copyright (c) 2025
 * Vercel; THIRD_PARTY_NOTICES): a header carrying the node's type and its place, the editable title under it, typed
 * ports as labelled handles on the card's left (inputs) and right (outputs) edges, and the card's actions in a footer.
 * Re-implemented here with our own markup and classes (agent-builder.module.css); no Tersa source is copied.
 *
 * Nothing on a card reaches a server or a provider (CLAUDE.md rule 3): it renames, moves and removes a node in the
 * browser's own draft, and there is deliberately no "run" control. Inputs and buttons carry `nodrag` (a press on them
 * is not a node drag) and `nokey` (Enter, Space or Delete typed on them is theirs, not React Flow's select or delete).
 */
import { createContext, useContext } from "react";
import { BaseEdge, EdgeLabelRenderer, Handle, Position, getBezierPath, type EdgeProps, type NodeProps } from "@xyflow/react";
import { fmt } from "@/lib/i18n/core";
import type { Dictionary } from "@/lib/i18n";
import { PORTS } from "@/lib/agent-graph-editor";
import type { AgentFlowEdge, AgentFlowNode } from "@/lib/agent-flow";
import styles from "./agent-builder.module.css";

export type AgentBuilderCopy = Dictionary["agentBuilder"];

/** What a card and a wire may do: change the draft, nothing else. The builder provides it; React Flow renders the views. */
export type AgentCanvasActions = {
  copy: AgentBuilderCopy;
  onRename: (id: string, label: string) => void;
  onRemove: (id: string) => void;
  onNudge: (id: string, index: number, dx: number, dy: number) => void;
  onDisconnect: (edgeId: string) => void;
  /** A node's label for a wire's accessible name ("Disconnect Brand kit from Campaign concept on canvas"). */
  labelOf: (id: string) => string;
};

export const AgentCanvasContext = createContext<AgentCanvasActions | null>(null);

function useCanvasActions(): AgentCanvasActions {
  const actions = useContext(AgentCanvasContext);
  if (!actions) throw new Error("AgentNode must be rendered inside AgentCanvasContext");
  return actions;
}

/** The keyboard and touch path for moving a card: the same 20px step the builder has always used. */
const NUDGES = [
  ["←", "left", -20, 0],
  ["↑", "up", 0, -20],
  ["↓", "down", 0, 20],
  ["→", "right", 20, 0],
] as const;

export function AgentNode({ data, selected }: NodeProps<AgentFlowNode>) {
  const { copy, onRename, onRemove, onNudge } = useCanvasActions();
  const { node, index } = data;
  const ports = PORTS[node.type];
  return (
    <article className={selected ? `${styles.node} ${styles.nodeSelected}` : styles.node} data-agent-node={node.id}>
      {/* Remove in the header, the arrows alone on the last row: with every control 40px, the card still fits the 250px row
          of the default grid (lib/agent-draft defaultNodePosition) instead of running under the card below it. */}
      <header className={styles.nodeTop}>
        <span className={styles.nodeBadge}>{node.type}</span>
        <button type="button" className={`nodrag nokey ${styles.nodeRemove}`} aria-label={fmt(copy.removeLabel, { label: node.label })} onClick={() => onRemove(node.id)}>
          {copy.remove}
        </button>
      </header>
      <input
        className={`nodrag nokey ${styles.nodeLabel}`}
        aria-label={fmt(copy.rename, { id: node.id })}
        maxLength={80}
        value={node.label}
        onChange={e => onRename(node.id, e.target.value)}
      />
      <div className={styles.nodeId}>{node.id} · {fmt(copy.node, { n: String(index + 1).padStart(2, "0") })}</div>
      <div className={styles.portGrid}>
        <div className={styles.portColumn}>
          <span className={styles.portHead}>{copy.inputs}</span>
          {ports.input.length === 0 && <span className={styles.portNone}>{copy.noPorts}</span>}
          {ports.input.map(port => (
            <div className={`${styles.portRow} ${styles.portIn}`} key={port}>
              {/* The id is for drawing a wire on the right port only; whether it may exist is decided by type (lib/agent-flow). */}
              <Handle type="target" position={Position.Left} id={port} className={styles.handle} aria-label={fmt(copy.inputPort, { port: copy.ports[port] })} />
              <span>{copy.ports[port]}</span>
            </div>
          ))}
        </div>
        <div className={`${styles.portColumn} ${styles.portColumnOut}`}>
          <span className={styles.portHead}>{copy.outputs}</span>
          {ports.output.length === 0 && <span className={styles.portNone}>{copy.noPorts}</span>}
          {ports.output.map(port => (
            <div className={`${styles.portRow} ${styles.portOut}`} key={port}>
              <span>{copy.ports[port]}</span>
              <Handle type="source" position={Position.Right} id={port} className={styles.handle} aria-label={fmt(copy.outputPort, { port: copy.ports[port] })} />
            </div>
          ))}
        </div>
      </div>
      <footer className={styles.nodeFooter}>
        <div className={styles.nudge}>
          {NUDGES.map(([symbol, dir, dx, dy]) => (
            <button
              type="button"
              key={dir}
              className="nodrag nokey"
              aria-label={fmt(copy.move, { label: node.label, dir: copy.dir[dir] })}
              onClick={() => onNudge(node.id, index, dx, dy)}
            >
              {symbol}
            </button>
          ))}
        </div>
      </footer>
    </article>
  );
}

/**
 * A wire: a curve with a wide invisible hit path. Its × (disconnect without a keyboard) is shown only while the wire is
 * selected, just before the input it ends on: drawn on every wire at its middle it sat under cards in the default layout
 * and was a Tab stop nobody could see. A tap or Enter selects the wire; the connection list below keeps an × for every
 * wire at all times.
 */
export function AgentEdge({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, interactionWidth }: EdgeProps<AgentFlowEdge>) {
  const { copy, onDisconnect, labelOf } = useCanvasActions();
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  // A wire always enters its input from the left, so 22px left of the port is on the wire and outside the target card.
  const [labelX, labelY] = [targetX - 22, targetY];
  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={interactionWidth} className={selected ? `${styles.wire} ${styles.wireSelected}` : styles.wire} />
      {selected && <EdgeLabelRenderer>
        <button
          type="button"
          className={`nodrag nopan nokey ${styles.wireRemove}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          aria-label={fmt(copy.disconnectCanvas, { from: labelOf(source), to: labelOf(target) })}
          onClick={() => onDisconnect(id)}
        >
          <span aria-hidden>×</span>
        </button>
      </EdgeLabelRenderer>}
    </>
  );
}
