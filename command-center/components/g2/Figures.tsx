import type { ReactNode } from "react";

/**
 * A strip of figures between rules: each is a small label over a big number
 * (tabular figures), with an optional line under it. Replaces a row of boxed
 * stat cards; the numbers are the page's, never decoration.
 *
 * `tone` colours the figure the way a lamp would: ok green, fail red, warn
 * caution, idle muted. A figure with no tone is plain text.
 */
export type FigureTone = "ok" | "fail" | "warn" | "idle";

const COLOR: Record<FigureTone, string> = {
  ok: "var(--color-ok)",
  fail: "var(--color-fail)",
  warn: "var(--color-warn)",
  idle: "var(--color-muted)",
};

export function Figures({ label, items }: { label?: string; items: { label: string; value: ReactNode; sub?: ReactNode; tone?: FigureTone }[] }) {
  return (
    <dl className="g2-figures" aria-label={label} style={{ margin: 0 }}>
      {items.map((it) => (
        <div key={it.label} className="g2-figure">
          <dt className="g2-label">{it.label}</dt>
          <dd className="g2-figure-value" style={{ color: it.tone ? COLOR[it.tone] : undefined, margin: 0 }}>
            {it.value}
          </dd>
          {it.sub !== undefined && <div className="g2-figure-sub">{it.sub}</div>}
        </div>
      ))}
    </dl>
  );
}
