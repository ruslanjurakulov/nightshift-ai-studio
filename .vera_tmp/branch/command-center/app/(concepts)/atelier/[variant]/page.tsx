import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary } from "@/lib/i18n/server";
import { conceptsEnabled, isConceptVariant } from "@/lib/concepts";
import { paddleConfig } from "@/lib/paddle";
import { PRICING_ENV, resolvePricing } from "@/lib/pricing";
import { moneyAnchor } from "@/lib/landing";
import { readPublicApiPrices } from "@/lib/server/api-prices";
import { readPublicCreditRates } from "@/lib/server/public-rates";
import { ConceptShell } from "@/components/concepts/ConceptShell";
import { ConceptA } from "@/components/concepts/ConceptA";
import { ConceptB } from "@/components/concepts/ConceptB";
import { ConceptC } from "@/components/concepts/ConceptC";

// Read per request, never prerendered: the flag is an environment variable of
// the running server (lib/concepts.ts), and a page built once must not freeze
// the decision.
export const dynamic = "force-dynamic";

/** A prototype is never indexed or followed, whatever else is configured. */
export const metadata: Metadata = {
  title: { absolute: "Atelier concept" },
  robots: { index: false, follow: false, nocache: true },
};

/**
 * /atelier/{a|b|c}: the three Atelier hero concepts (docs/design/ATELIER_CONCEPTS.md).
 * Off unless ATELIER_CONCEPTS=1; the middleware already answers 404 for the
 * whole namespace when it is off, and this page checks again, so a request
 * that reached it by any other route is still a 404.
 */
export default async function ConceptPage({
  params,
  searchParams,
}: {
  params: Promise<{ variant: string }>;
  searchParams: Promise<{ bare?: string | string[] }>;
}) {
  if (!conceptsEnabled()) notFound();
  const { variant } = await params;
  if (!isConceptVariant(variant)) notFound();
  const { bare } = await searchParams;

  const { t, locale } = await getDictionary();
  // The same public price sources the live landing reads, bounded and cached.
  const [apiPrices, siteRates] = await Promise.all([readPublicApiPrices(), readPublicCreditRates()]);
  const anchor = moneyAnchor(resolvePricing(PRICING_ENV, paddleConfig), apiPrices, siteRates);

  return (
    <ConceptShell t={t} variant={variant} bare={bare === "1"}>
      {variant === "a" && <ConceptA t={t} locale={locale} anchor={anchor} />}
      {variant === "b" && <ConceptB t={t} locale={locale} anchor={anchor} />}
      {variant === "c" && <ConceptC t={t} locale={locale} anchor={anchor} />}
    </ConceptShell>
  );
}
