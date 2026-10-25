import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { Note } from "@/components/g3/Section";
import { RegionEditor } from "@/components/regionEdit/RegionEditor";
import { getDictionary } from "@/lib/i18n/server";
import { fmt } from "@/lib/i18n";
import { getOrgContext } from "@/lib/orgs-server";
import { getChannelContext } from "@/lib/channels-server";
import { channelPath } from "@/lib/channels";
import { loadStudioModels } from "@/lib/server/creative";
import { regionEditorEnabled } from "@/lib/regionEdit/flag";
import { editModels } from "@/lib/regionEdit/quote";
import { MAX_REGIONS } from "@/lib/regionEdit/geometry";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Region editor (NIGHTSHIFT_REGION_EDITOR, default off: this page is then a 404, exactly as if it did not exist).
 * Draw up to five rectangles on a library picture, give each its own words, see the price before anything runs. The
 * models offered are the ones the database lets this member buy that can edit pictures (migration 0035): none
 * is a default and none stands in for another. Running the edits is not connected yet (docs/REGION_EDITOR.md).
 */
export default async function RegionEditorPage() {
  if (!regionEditorEnabled()) notFound();
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const { slug } = await getChannelContext();
  const org = await getOrgContext();
  const header = <PageHeader icon="studio" title={t.regionEdit.title} subtitle={fmt(t.regionEdit.subtitle, { max: MAX_REGIONS })} />;
  if (!org.supported) return <div className="rhythm ns-open">{header}<Note>{t.org.notMigrated}</Note></div>;
  if (!org.current) return <div className="rhythm ns-open">{header}<Note>{t.regionEdit.errors.org_required}</Note></div>;
  const models = editModels(await loadStudioModels()).map((m) => ({ id: m.id, displayName: m.displayName }));
  return (
    <div className="rhythm ns-open stagger-enter">
      {header}
      <RegionEditor orgId={org.current.id} models={models} libraryHref={channelPath(slug, "/library")} />
    </div>
  );
}
