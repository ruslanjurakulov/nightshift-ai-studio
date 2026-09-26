import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { createClient } from "@/lib/supabase/server";
import { readCreditPrices } from "@/lib/server/credits";
import { paddleConfig } from "@/lib/paddle";
import { PRICING_ENV, creditRates, resolvePricing, type CreditRates } from "@/lib/pricing";
import { PublicShell } from "@/components/legal/PublicShell";
import { PricingView } from "@/components/pricing/PricingView";

// Who is asking decides the rates panel, so this is never a static page.
export const dynamic = "force-dynamic";

/** Public: middleware lets this path through signed in or out (lib/public-paths.ts). */
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getDictionary();
  return { title: `${t.pricing.title} · ${t.brand.name}`, description: t.pricing.metaDescription };
}

/**
 * What a credit pack costs, what a credit buys, and who sells it — the page
 * Paddle's seller verification reads, and the one the Terms link to.
 *
 * Prices come only from Paddle's preview or the owner's display env
 * (lib/pricing.ts). The live credit rates come from credit_prices, which RLS
 * (0020) shows to signed-in accounts only: a signed-out visitor is told that,
 * rather than shown a number this page would have had to guess.
 */
export default async function PricingPage() {
  const { t, locale } = await getDictionary();
  const pricing = resolvePricing(PRICING_ENV, paddleConfig);

  const supabase = await createClient();
  const user = supabase ? (await supabase.auth.getUser()).data.user : null;
  let rates: CreditRates | null = null;
  if (supabase && user) {
    const res = await readCreditPrices(supabase);
    if (res.supported) rates = creditRates(res.prices);
  }

  return (
    <PublicShell t={t}>
      <PricingView t={t} locale={locale} pricing={pricing} signedIn={Boolean(user)} rates={rates} />
    </PublicShell>
  );
}
