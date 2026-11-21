import { LoadingGrace } from "@/components/motion/LoadingGrace";
import "@/app/(app)/app-pages-g5.css";

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
 * The generic shape of a section, drawn the way the pages are: a title and a
 * lead, a row of figures, and ruled rows — no boxes. Close enough to every
 * screen that the content replacing it does not jump the layout, without
 * pretending to know what the screen will say.
 */
export function PageSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="w-full min-w-0">
      <span className="sr-only">{label}</span>
      {/* After a click the blocks wait out a short grace period, so a fast
          route never flashes them; the status line above is announced at once. */}
      <LoadingGrace className="g5-skel">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-2/3 max-w-sm" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
        <div className="g5-skel-figs">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col gap-3">
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-8 w-3/4" />
            </div>
          ))}
        </div>
        <div className="g5-skel-rows">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="g5-skel-row" style={{ opacity: 1 - i * 0.14 }}>
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="ml-auto h-4 w-1/5" />
            </div>
          ))}
        </div>
      </LoadingGrace>
    </div>
  );
}
