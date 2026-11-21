import { getDictionary } from "@/lib/i18n/server";
import "@/components/presets/presets.css";

/** The gallery's skeleton: the shape of the grid while the page loads. */
export default async function Loading() {
  const { t } = await getDictionary();
  return (
    <div className="flex flex-col gap-6" role="status" aria-live="polite">
      <span className="sr-only">{t.presets.loading}</span>
      <div className="flex flex-col gap-3" aria-hidden>
        <div className="h-11 rounded-[var(--ns-r-key)] bg-[var(--color-panel-2)]" />
        <div className="h-11 w-3/4 rounded-[var(--ns-r-key)] bg-[var(--color-panel-2)]" />
      </div>
      <ul className="pr-skel" aria-hidden>
        {Array.from({ length: 8 }, (_, i) => (
          <li key={i} />
        ))}
      </ul>
    </div>
  );
}
