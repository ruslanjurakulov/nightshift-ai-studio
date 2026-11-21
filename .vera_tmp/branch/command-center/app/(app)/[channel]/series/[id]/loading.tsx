import { PageSkeleton } from "@/components/feedback/Skeleton";
import { getDictionary } from "@/lib/i18n/server";

/** The plan page's loading state: shown while the plan and its episode quotes are read. */
export default async function SeriesPlanLoading() {
  const { t } = await getDictionary();
  return <PageSkeleton label={t.ux.loading} />;
}
