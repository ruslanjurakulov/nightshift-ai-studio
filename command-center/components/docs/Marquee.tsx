/**
 * Offset rows of pills that drift sideways, forever, slowly: CSS only (a
 * translateX keyframe over a track that holds the row twice, so the loop has no
 * seam). The rows are decoration: the names are in the page's text for a screen
 * reader, the whole block is aria-hidden, the second copy of each row is never
 * reachable, and nothing in it takes focus. Hover pauses it. Under
 * prefers-reduced-motion it does not move at all: the rows stop being a strip
 * and wrap into plain, still pills, each name once (site.css).
 */
export type MarqueeRow = { id: string; items: React.ReactNode[]; reverse?: boolean; seconds?: number; /** How many times a set repeats its items, so one set is wider than any screen and the loop has no gap. */ repeat?: number };

function setOf(row: MarqueeRow) {
  const n = row.items.length;
  return Array.from({ length: row.repeat ?? 1 }, () => row.items)
    .flat()
    .map((it, i) => (
      <li key={i} className={i >= n ? "ml-mq-rep" : undefined}>
        {it}
      </li>
    ));
}

export function Marquee({ rows }: { rows: MarqueeRow[] }) {
  return (
    <div className="ml-mq" aria-hidden>
      {rows.map((row) => (
        <div key={row.id} className="ml-mq-row" data-reverse={row.reverse || undefined} style={{ ["--mq-s" as string]: `${row.seconds ?? 90}s` }}>
          <div className="ml-mq-track">
            <ul className="ml-mq-set">{setOf(row)}</ul>
            <ul className="ml-mq-set ml-mq-dup">{setOf(row)}</ul>
          </div>
        </div>
      ))}
    </div>
  );
}
