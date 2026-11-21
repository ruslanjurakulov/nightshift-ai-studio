import { PageHeader } from "@/components/PageHeader";
import { getDictionary } from "@/lib/i18n/server";

/** The page's own header over four skeleton panels, so nothing jumps when the numbers arrive. */
export default async function Loading() {
  const { t } = await getDictionary();
  const panels = [t.research.own.title, t.research.competitors.title, t.research.topic.title, t.research.themes.title];
  return (
    <div className="rhythm">
      <PageHeader icon="research" title={t.research.title} subtitle={t.research.subtitle} />
      <div className="flex flex-col gap-6" aria-busy="true">
        {panels.map((title) => (
          <section key={title} className="section-card flex flex-col gap-3" aria-label={title}>
            <h2 className="t-panel m-0">{title}</h2>
            <div className="skeleton h-4 w-40" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="skeleton h-10 w-full" />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
