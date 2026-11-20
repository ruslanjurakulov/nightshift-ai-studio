import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { TrendsScreen } from "@/components/customer/TrendsScreen";

export const dynamic = "force-dynamic";

/**
 * Trends: every trend template (stream S3's GET /api/templates). Each opens Create with the template filled
 * (/create?template=<slug>); nothing is priced or spent until Create's own press. Until S3's route is deployed the
 * screen says the templates are on their way instead of showing an empty list or an error.
 */
export default function TrendsPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  return <TrendsScreen />;
}
