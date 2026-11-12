import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { Note } from "@/components/g3/Section";
import { CharacterStudio } from "@/components/character-studio/CharacterStudio";
import "@/components/character-studio/character-studio.css";
import { createClient } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { getOrgContext } from "@/lib/orgs-server";
import { getChannelPath } from "@/lib/channels-path-server";
import { characterStudioEnabled } from "@/lib/characterStudio/model";
import { characterStudioStrings } from "@/lib/i18n/character-studio";
import { loadStudio } from "@/lib/server/character-studio";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Character Studio, "Qahramon studiyasi" (NIGHTSHIFT_CHARACTER_STUDIO, default off: this page is then a 404, exactly as if it did not
 * exist, and the navigation has no entry for it). docs/CHARACTER_STUDIO.md: a member picks a video and pictures from their library,
 * chooses the model by its price for that clip, declares the consent and asks for one swap; the worker does the rest. The page reads
 * under the member's own session (RLS) and never calls a vendor.
 */
export default async function CharacterStudioPage() {
  if (!characterStudioEnabled()) notFound();
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t, locale } = await getDictionary();
  const s = characterStudioStrings(locale);
  const org = await getOrgContext();
  const header = <PageHeader icon="characterStudio" title={s.title} subtitle={s.subtitle} />;
  if (!org.supported) return <div className="rhythm ns-open">{header}<Note>{t.org.notMigrated}</Note></div>;
  if (!org.current) return <div className="rhythm ns-open">{header}<Note>{t.org.noOrg}</Note></div>;
  const supabase = await createClient();
  if (!supabase) return <NotConfigured />;
  const path = await getChannelPath();
  const initial = await loadStudio(supabase, org.current.id, { urls: true });
  // Presentation only: a viewer sees the gallery and the cost without the button. The database checks the role again on every write.
  const canEdit = ["owner", "admin", "editor"].includes(org.current.role);
  return (
    <div className="rhythm ns-open stagger-enter">
      {header}
      <CharacterStudio enabled orgId={org.current.id} canEdit={canEdit} initial={initial} libraryHref={path("/library")} />
    </div>
  );
}
