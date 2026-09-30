import { num, relativeTime } from "@/lib/format";

interface Point {
  date: string;
  views: number | null;
}

/**
 * Minimal inline-SVG sparkline of a video's views across its metrics snapshots,
 * plus a compact list of the underlying values. Renders only real snapshot
 * numbers — points with no views value are dropped from the line and shown as
 * N/A in the list. No client JS needed.
 */
export function ViewsSparkline({ points, label = "Views over time" }: { points: Point[]; label?: string }) {
  const series = points.filter((p): p is { date: string; views: number } => p.views != null);

  const W = 480;
  const H = 64;
  const PAD = 4;

  let path: string | null = null;
  if (series.length >= 2) {
    const max = Math.max(...series.map((p) => p.views));
    const min = Math.min(...series.map((p) => p.views));
    const span = max - min || 1;
    const stepX = (W - PAD * 2) / (series.length - 1);
    path = series
      .map((p, i) => {
        const x = PAD + i * stepX;
        const y = PAD + (H - PAD * 2) * (1 - (p.views - min) / span);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }

  return (
    <div className="flex flex-col gap-3">
      {path && (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-16 w-full"
          role="img"
          aria-label={label}
        >
          <path
            d={path}
            fill="none"
            stroke="var(--color-primary)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <tbody>
            {points.map((p) => (
              <tr key={p.date} className="border-b border-[var(--color-border)]/50">
                <td className="py-1.5 pr-4 mono text-[11px] text-[var(--color-muted)]">
                  {relativeTime(p.date)}
                </td>
                <td className="py-1.5 mono text-[10px] text-[var(--color-muted)]">{p.date}</td>
                <td className="py-1.5 text-right mono tabular-nums text-[var(--color-fg)]">
                  {num(p.views)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
