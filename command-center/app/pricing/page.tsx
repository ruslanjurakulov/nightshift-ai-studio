import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { createClient } from "@/lib/supabase/server";
import { readCreditPrices } from "@/lib/server/credits";
import { paddleClient, paddleConfig } from "@/lib/paddle";
import { PRICING_ENV, creditRates, resolvePricing, type CreditRates } from "@/lib/pricing";
import { PLAN_ENV, planMatrix } from "@/lib/plans";
import { planValue, readPlanCatalog, type PlanRead } from "@/lib/server/plans";
import { generationRates, type GenerationRates, type PlanCatalog } from "@/lib/plans";
import { readSellableModels } from "@/lib/creative/registry";
import { moneyAnchor, runtimeSiteOrigin, shareMetadata } from "@/lib/landing";
import { readPublicApiPrices } from "@/lib/server/api-prices";
import { PublicShell } from "@/components/legal/PublicShell";
import { PricingView } from "@/components/pricing/PricingView";

// Who is asking decides the rates panel, so this is never a static page.
export const dynamic = "force-dynamic";

/** Public: middleware lets this path through signed in or out (lib/public-paths.ts). */
export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getDictionary();
  const title = `${t.pricing.title} · ${t.brand.name}`;
  const description = t.pricing.metaDescription;
  return {
    title: { absolute: title },
    description,
    ...shareMetadata({
      origin: runtimeSiteOrigin(),
      path: "/pricing",
      title,
      description,
      siteName: t.brand.name,
      imageAlt: t.landing.meta.ogAlt,
      locale,
    }),
  };
}

/**
 * What a credit pack costs, what a credit buys, and who sells it — the page
 * Paddle's seller verification reads, and the one the Terms link to.
 *
 * Prices come only from Paddle's preview or the owner's display env
 * (lib/pricing.ts). The live credit rates come from credit_rates() (0084: the
 * rates as charged, never the margin), which only a signed-in account may
 * call: a signed-out visitor is told that,
 * rather than shown a number this page would have had to guess.
 */
export default async function PricingPage() {
  const { t, locale } = await getDictionary();
  const pricing = resolvePricing(PRICING_ENV, paddleConfig);
  // The only money a signed-out visitor can be shown: published pack prices
  // and the live API price list (public by 0031). Read alongside the rest.
  const apiPricesRead = readPublicApiPrices();

  const supabase = await createClient();
  const user = supabase ? (await supabase.auth.getUser()).data.user : null;
  let rates: CreditRates | null = null;
  let ratesFailed = false;
  let genRates: GenerationRates | null = null;
  if (supabase && user) {
    const [res, models] = await Promise.all([readCreditPrices(supabase), readSellableModels(supabase)]);
    // A failed read is no rates at all — not an empty price list — and the
    // page says it could not read them, which is not "not published yet".
    if (res.supported && !res.failed) {
      rates = creditRates(res.prices);
      // "≈ N images · M videos" from the same two reads the Credits page uses;
      // a model list that could not be read leaves those parts out, never guessed.
      genRates = generationRates(models.status === "ok" ? models.models : null, res.prices);
    }
    ratesFailed = res.failed;
  }
  // The plan catalog is a public price list (0034): read signed in or out.
  // `unsupported` (0034 not applied) offers no plans, as before; `failed` says
  // the plans could not be read instead of silently showing none.
  const catalogRead: PlanRead<PlanCatalog> = supabase
    ? await readPlanCatalog(supabase).catch(() => ({ state: "failed" as const }))
    : { state: "unsupported" };
  const catalog = planValue(catalogRead);
  const plans = planMatrix(catalog, PLAN_ENV, paddleClient);

  return (
    <PublicShell t={t}>
      <PricingView
        t={t}
        locale={locale}
        pricing={pricing}
        signedIn={Boolean(user)}
        rates={rates}
        ratesFailed={ratesFailed}
        generationRates={genRates}
        plansFailed={catalogRead.state === "failed"}
        plans={plans}
        packValidMonths={catalog?.packValidMonths}
        anchor={moneyAnchor(pricing, await apiPricesRead)}
      />
    </PublicShell>
  );
}
