import { Skeleton } from "@/components/feedback/Skeleton";

/**
 * The library while its list is on the way: the storage bar, the chips and a
 * grid of tiles in the shape the real ones will take, so nothing jumps when
 * they arrive. It is never an empty state — "nothing here yet" is only said
 * once the list has actually come back empty.
 *
 * Server-safe (the route's loading.tsx uses it) and decorative except for the
 * one status line a screen reader hears.
 */
export function LibrarySkeleton({ label, tiles = 8 }: { label: string; tiles?: number }) {
  return (
    <div role="status" aria-live="polite" data-library-skeleton className="flex w-full min-w-0 flex-col gap-4">
      <span className="sr-only">{label}</span>
      <div className="panel flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-4 w-40 max-w-full" />
          <Skeleton className="h-1.5 w-56 max-w-full" />
        </div>
        <Skeleton className="h-10 w-32 shrink-0 rounded-full" />
      </div>
      <div className="flex gap-2 overflow-hidden">
        {[64, 84, 78, 70].map((w, i) => (
          <Skeleton key={i} className="h-9 shrink-0 rounded-full" style={{ width: w }} />
        ))}
      </div>
      <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" aria-hidden>
        {Array.from({ length: tiles }, (_, i) => (
          <li key={i} className="flex flex-col gap-2" style={{ opacity: 1 - Math.min(i, 6) * 0.08 }}>
            <Skeleton className="aspect-square w-full rounded-2xl" />
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </li>
        ))}
      </ul>
    </div>
  );
}
