import { PageHeader } from "@/components/PageHeader";
import { LibrarySkeleton } from "@/components/media/LibrarySkeleton";
import { getDictionary } from "@/lib/i18n/server";

/**
 * Shown while the library page reads its list. The library has its own shape
 * (chips, a grid of tiles), so it gets its own skeleton rather than the
 * section's generic one — and never an empty state before the list is here.
 */
export default async function LibraryLoading() {
  const { t } = await getDictionary();
  return (
    <div className="rhythm">
      <PageHeader icon="library" title={t.media.title} />
      <LibrarySkeleton label={t.media.loading} />
    </div>
  );
}
