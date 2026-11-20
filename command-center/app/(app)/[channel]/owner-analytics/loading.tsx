import { getDictionary } from "@/lib/i18n/server";
import "./owner-analytics.css";

/** Skeletons in the shape of the figures, so the layout does not jump when they arrive. No number is drawn until it is read. */
export default async function Loading() {
  const { t } = await getDictionary();
  return (
    <div className="oa" aria-busy="true">
      <p className="sr-only" role="status">
        {t.ownerAnalytics.loading}
      </p>
      <div className="oa-skeleton" style={{ height: 40, width: "40%" }} />
      <div className="oa-skeleton" style={{ height: 32 }} />
      <div className="oa-grid-kpi">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="oa-skeleton" style={{ height: 84 }} />
        ))}
      </div>
      <div className="oa-skeleton" style={{ height: 280 }} />
    </div>
  );
}
