/**
 * A connector between two cards on the live canvas (LIVE_CREATION_PLAN §2): a curved 1.5 px line coloured by the data it
 * carries, drawn in over 300 ms when it first appears, with a travelling dash only while data actually flows along it.
 *
 * It renders a <g> so it can sit inside any SVG: S3's StoryBoard passes it to xyflow as a custom edge, the specimen draws it
 * in a plain <svg>. It is decoration (aria-hidden): the cards say what is connected and what state each is in.
 */
import type { LiveMediaType } from "./model";
import "./live.css";

/** ghost: planned, not made (dashed, quiet). idle: made, nothing moving. flowing: a real job is moving data along it. */
export type LiveConnectorState = "ghost" | "idle" | "flowing";

/**
 * A horizontal S-curve from (x1, y1) to (x2, y2): both ends leave and enter level, the way a card's handle points. The pull
 * grows with the distance but never past 160 px, so a long edge does not balloon into a loop.
 */
export function connectorPath(x1: number, y1: number, x2: number, y2: number): string {
  const pull = Math.min(Math.max(Math.abs(x2 - x1) * 0.5, 24), 160);
  const r = (n: number) => Math.round(n * 10) / 10;
  return `M ${r(x1)} ${r(y1)} C ${r(x1 + pull)} ${r(y1)}, ${r(x2 - pull)} ${r(y2)}, ${r(x2)} ${r(y2)}`;
}

export function LiveConnector({
  d,
  media,
  state,
  draw = true,
}: {
  /** The path, from connectorPath or xyflow's own getBezierPath. */
  d: string;
  media: LiveMediaType;
  state: LiveConnectorState;
  /** Draw in on mount. False for an edge that was already there (a refresh): it is simply present. */
  draw?: boolean;
}) {
  return (
    <g className="live-edge" data-media={media} data-state={state} data-draw={draw ? "true" : undefined} aria-hidden>
      {/* pathLength=1 lets the draw-in run on any length with one dash rule; a ghost is dashed in real units instead. */}
      <path className="live-edge-line" d={d} pathLength={state === "ghost" ? undefined : 1} fill="none" />
      {state === "flowing" ? <path className="live-edge-flow" d={d} fill="none" /> : null}
    </g>
  );
}
