import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { readPublicApiPrices } from "@/lib/server/api-prices";
import { PublicShell } from "@/components/legal/PublicShell";
import { ApiDocs } from "@/components/docs/ApiDocs";
import { docsOrigin } from "@/lib/api/docs-origin";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "API reference · Nightshift",
  description: "The Nightshift REST API: make, list, publish and download videos with an API key.",
};

/**
 * Public: the API reference (lib/public-paths.ts). The price table is the
 * live api_prices list (0031 lets anyone read it — it is a price list); when
 * it cannot be read, the page says no price is published. The seeded
 * defaults never appear: they are not a price anyone set.
 */
export default async function ApiDocsPage() {
  const { t } = await getDictionary();
  const prices = await readPublicApiPrices();
  return (
    <PublicShell t={t} current="docs">
      <ApiDocs prices={prices} origin={docsOrigin()} labels={{ table: t.common.scrollTable, code: t.common.scrollCode }} />
    </PublicShell>
  );
}
