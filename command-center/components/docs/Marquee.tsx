/**
 * Rows of pills that drift sideways, forever, slowly, all the same way at the same speed: CSS only (a
 * translateX keyframe over a track that holds the row twice, so the loop has no
 * seam). The rows are decoration: the names are in the page's text for a screen
 * reader, the whole block is aria-hidden, the second copy of each row is never
 * reachable, and nothing in it takes focus. Hover pauses it. Under
 * prefers-reduced-motion it does not move at all: the rows stop being a strip
 * and wrap into plain, still pills (site.css). Rows hold different clients (none in two rows), each row is wider than the strip's
 * capped width (1000 px, centred, faded at both edges), so the loop has no seam and no logo repeats in view. The pause button is MarqueePause.
 */
export type MarqueeRow = { id: string; items: React.ReactNode[]; seconds?: number };

export function Marquee({ rows }: { rows: MarqueeRow[] }) {
  return (
    <div className="ml-mq" aria-hidden>
      {rows.map((row) => (
        <div key={row.id} className="ml-mq-row" style={{ ["--mq-s" as string]: `${row.seconds ?? 90}s` }}>
          <div className="ml-mq-track">
            <ul className="ml-mq-set">{row.items.map((it, i) => <li key={i}>{it}</li>)}</ul>
            <ul className="ml-mq-set ml-mq-dup">{row.items.map((it, i) => <li key={i}>{it}</li>)}</ul>
          </div>
        </div>
      ))}
    </div>
  );
}
