/**
 * Placeholder shapes while a route streams in. The `.skeleton` shimmer lives in
 * globals.css, so the page-wide prefers-reduced-motion rule already stills it —
 * a reduced-motion visitor sees calm grey blocks, not a sweeping gradient.
 *
 * Decorative only: the one thing a screen reader hears is PageSkeleton's
 * status line.
 */
export function Skeleton({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <div aria-hidden className={`skeleton ${className}`} style={style} />;
}

/**
 * The generic shape of a section: a title, a row of stat cards, and a panel of
 * rows. Close enough to every screen that the content replacing it does not
 * jump the layout, without pretending to know what the screen will say.
 */
export function PageSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="flex w-full min-w-0 flex-col gap-6">
      <span className="sr-only">{label}</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-2/3 max-w-xs" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="panel flex flex-col gap-2 p-4">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-6 w-3/4" />
          </div>
        ))}
      </div>
      <div className="panel flex flex-col gap-3 p-4">
        <Skeleton className="h-4 w-40" />
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-9 w-full" style={{ opacity: 1 - i * 0.14 }} />
        ))}
      </div>
    </div>
  );
}
