import { PageHeader } from "@/components/PageHeader";
import { getDictionary } from "@/lib/i18n/server";
import { TrendCardSkeleton } from "@/components/trends/TrendCard";
import "@/components/trends/trends.css";

/** The page's own header over the skeletons, so nothing jumps when the gallery arrives. */
export default async function Loading() {
  const { t } = await getDictionary();
  return (
    <div className="rhythm">
      <PageHeader icon="trends" title={t.trends.title} subtitle={t.trends.subtitle} />
      <ul className="tr-grid" aria-busy="true" aria-label={t.trends.loading}>
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i}>
            <TrendCardSkeleton />
          </li>
        ))}
      </ul>
    </div>
  );
}
