import { Skeleton } from "@/components/feedback/Skeleton";
import { getDictionary } from "@/lib/i18n/server";

/**
 * The catalog's shape while the registry and the price list are read: the
 * search field, the task keys and a strip of frames, so the page does not
 * jump when the models arrive. It names no model and no price.
 */
export default async function ModelsLoading() {
  const { t } = await getDictionary();
  return (
    <div role="status" aria-live="polite" className="flex w-full min-w-0 flex-col gap-4">
      <span className="sr-only">{t.ux.loading}</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <Skeleton className="h-11 w-full" />
      <div className="flex gap-2 overflow-hidden">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-8 w-28 shrink-0" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-[3px] rounded-[2px] bg-[var(--ns-film)] p-[3px] md:grid-cols-3 xl:grid-cols-4">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <div key={i} className="aspect-[16/10] bg-[color-mix(in_srgb,var(--ns-on-film)_8%,var(--ns-film))]" />
        ))}
      </div>
    </div>
  );
}
