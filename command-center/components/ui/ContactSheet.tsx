import type { CSSProperties, ReactNode } from "react";

/**
 * Results as a proof sheet (IDENTITY.md §Signature devices): frames on a
 * strip of black film, each with its edge print — the frame's own facts
 * (shape, length, price, number) set small in amber, the way film stock prints
 * its frame numbers in the rebate. The edge print carries only what the caller
 * knows; an empty one is not drawn, and it is never filler.
 *
 * `TileGrid` is the same responsive grid without the film, for cards that are
 * not frames (presets, models).
 */
export function TileGrid({
  min = 160,
  gap = 12,
  as: Tag = "ul",
  label,
  children,
  className,
}: {
  /** The narrowest a tile may get (px) before the grid drops a column. */
  min?: number;
  gap?: number;
  as?: "ul" | "div";
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  const style = { "--tile-min": `${min}px`, "--tile-gap": `${gap}px` } as CSSProperties;
  return (
    <Tag className={`ns-tile-grid${className ? ` ${className}` : ""}`} style={style} aria-label={label}>
      {children}
    </Tag>
  );
}

export function ContactSheet({
  min = 160,
  label,
  children,
  className,
}: {
  min?: number;
  /** What the sheet holds ("Results"); it is a list of frames. */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const style = { "--tile-min": `${min}px` } as CSSProperties;
  return (
    <ul className={`ns-sheet${className ? ` ${className}` : ""}`} style={style} aria-label={label}>
      {children}
    </ul>
  );
}

export function Frame({
  number,
  edge = [],
  aspect,
  selected = false,
  caption,
  children,
  className,
}: {
  /** The frame's number on the sheet, if it has a real order. */
  number?: number | string | null;
  /** Facts for the edge print, e.g. ["16:9", "0:05", "12 cr"]; empty items are dropped. */
  edge?: readonly (string | null | undefined | false)[];
  /** CSS aspect-ratio for the picture ("16 / 9"). */
  aspect?: string;
  selected?: boolean;
  /** Under the picture, on the film: the frame's title or "for whom" line. */
  caption?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const facts = edge.filter((x): x is string => typeof x === "string" && x.length > 0);
  const printed = number !== undefined && number !== null && number !== "";
  return (
    <li className={`ns-frame${className ? ` ${className}` : ""}`} data-selected={selected ? "true" : undefined}>
      {(printed || facts.length > 0) && (
        <div className="ns-edge">
          {printed && <span className="ns-edge-no">{number}</span>}
          {printed && <span aria-hidden>▸</span>}
          {facts.map((f, i) => (
            <span key={i}>{f}</span>
          ))}
        </div>
      )}
      <div className="ns-frame-media" style={aspect ? { aspectRatio: aspect } : undefined}>
        {children}
      </div>
      {caption && <div className="px-1 pb-1.5 pt-1 text-[12px] leading-snug">{caption}</div>}
    </li>
  );
}
