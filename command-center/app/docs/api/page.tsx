import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { readPublicApiPrices } from "@/lib/server/api-prices";
import { PublicShell } from "@/components/legal/PublicShell";
import { ApiDocs } from "@/components/docs/ApiDocs";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "API reference · Nightshift",
  description: "The Nightshift REST API: make, list, publish and download videos with an API key.",
};

/**
 * Public: the API reference (lib/public-paths.ts). The price table is the
 * live api_prices list (0031 lets anyone read it — it is a price list); when
 * it cannot be read, the page says it shows the default prices instead of
 * presenting them as current.
 */
/** The origin examples are written against: this deployment's APP_ORIGIN
 *  (compose sets it from DOMAIN), else the production domain. */
function siteOrigin(): string {
  try {
    const u = new URL(process.env.APP_ORIGIN?.trim() || "https://nightshift-ai.studio");
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : "https://nightshift-ai.studio";
  } catch {
    return "https://nightshift-ai.studio";
  }
}

export default async function ApiDocsPage() {
  const { t } = await getDictionary();
  const prices = await readPublicApiPrices();
  return (
    <PublicShell t={t}>
      <ApiDocs prices={prices} origin={siteOrigin()} labels={{ table: t.common.scrollTable, code: t.common.scrollCode }} />
    </PublicShell>
  );
}
