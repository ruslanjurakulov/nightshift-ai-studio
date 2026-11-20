import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { getDictionary } from "@/lib/i18n/server";
import { TrendsGallery } from "@/components/trends/TrendsGallery";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Trends: the formats people post right now (migration 0181), as cards that open Create prefilled. It prices nothing and starts
 * nothing; Create shows the price and asks before anything runs.
 */
export default async function TrendsPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  return (
    <div className="rhythm ns-open stagger-enter">
      <PageHeader icon="trends" title={t.trends.title} subtitle={t.trends.subtitle} />
      <TrendsGallery />
    </div>
  );
}
