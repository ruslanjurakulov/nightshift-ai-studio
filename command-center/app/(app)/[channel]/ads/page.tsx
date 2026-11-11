import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { Note } from "@/components/g3/Section";
import { AdsWorkspace } from "@/components/ads/AdsWorkspace";
import "@/components/ads/ads.css";
import { createClient } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { getOrgContext } from "@/lib/orgs-server";
import { getChannelPath } from "@/lib/channels-path-server";
import { adsFactoryEnabled } from "@/lib/adsFactory/flag";
import { loadAdsWorkspace } from "@/lib/server/ads-factory";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The Ads workspace (NIGHTSHIFT_ADS_FACTORY, default off: this page is then a 404, exactly as if it did not exist, and the
 * navigation has no entry for it). Phase 1 of docs/ADS_FACTORY.md: a member writes down a brand kit by hand (the logo and product
 * pictures come from the organization's own media library), plans a campaign and keeps concept drafts filled in from fixed
 * templates. The page reads under the member's own session (RLS) and never fetches a site, calls a model or touches credits.
 */
export default async function AdsPage() {
  if (!adsFactoryEnabled()) notFound();
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const org = await getOrgContext();
  const header = <PageHeader icon="ads" title={t.adsFactory.title} subtitle={t.adsFactory.subtitle} />;
  if (!org.supported) return <div className="rhythm ns-open">{header}<Note>{t.org.notMigrated}</Note></div>;
  if (!org.current) return <div className="rhythm ns-open">{header}<Note>{t.org.noOrg}</Note></div>;
  const supabase = await createClient();
  if (!supabase) return <NotConfigured />;
  const path = await getChannelPath();
  const initial = await loadAdsWorkspace(supabase, org.current.id, { urls: true });
  // Presentation only: a viewer sees the workspace without its buttons. The database checks the role again on every write.
  const canEdit = ["owner", "admin", "editor"].includes(org.current.role);
  return (
    <div className="rhythm ns-open stagger-enter">
      {header}
      <AdsWorkspace orgId={org.current.id} canEdit={canEdit} initial={initial} libraryHref={path("/library")} />
    </div>
  );
}
