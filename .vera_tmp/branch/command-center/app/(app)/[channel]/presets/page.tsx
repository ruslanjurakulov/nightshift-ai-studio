import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { getDictionary } from "@/lib/i18n/server";
import { PresetsGallery } from "@/components/presets/PresetsGallery";
import "../../app-pages-g2.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Presets & looks: every starting point the product already has — video
 * formats, the Style Library's looks, Studio templates and the voice list —
 * as one searchable gallery. It reads nothing from the database and calls
 * nothing: each card is a link that opens the form which takes that preset,
 * where the price is shown and the confirmation is asked.
 */
export default async function PresetsPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  return (
    <div className="rhythm ns-open stagger-enter">
      <PageHeader icon="styles" title={t.presets.title} subtitle={t.presets.subtitle} />
      <PresetsGallery />
    </div>
  );
}
