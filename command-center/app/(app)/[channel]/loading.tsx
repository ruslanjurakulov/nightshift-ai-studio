import { PageSkeleton } from "@/components/feedback/Skeleton";
import { getDictionary } from "@/lib/i18n/server";

/**
 * Shown the moment a section link is clicked, while the server component reads
 * Supabase. Without it the old screen just sits there and the click looks
 * ignored — people click again.
 */
export default async function SectionLoading() {
  const { t } = await getDictionary();
  return <PageSkeleton label={t.ux.loading} />;
}
