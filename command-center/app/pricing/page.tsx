import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { createClient } from "@/lib/supabase/server";
import { readCreditPrices } from "@/lib/server/credits";
import { paddleClient, paddleConfig } from "@/lib/paddle";
import { PRICING_ENV, creditRates, resolvePricing, type CreditRates } from "@/lib/pricing";
import { PLAN_ENV, planMatrix } from "@/lib/plans";
import { planValue, readPlanCatalog, type PlanRead } from "@/lib/server/plans";
import type { PlanCatalog } from "@/lib/plans";
import { siteOrigin } from "@/lib/landing";
import { PublicShell } from "@/components/legal/PublicShell";
import { PricingView } from "@/components/pricing/PricingView";

// Who is asking decides the rates panel, so this is never a static page.
export const dynamic = "force-dynamic";

/** Served by app/og.png/route.tsx — the homepage's card, for the same brand. */
const OG_IMAGE = { url: "/og.png", width: 1200, height: 630, type: "image/png" };

/** Public: middleware lets this path through signed in or out (lib/public-paths.ts). */
export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getDictionary();
  const title = `${t.pricing.title} · ${t.brand.name}`;
  const description = t.pricing.metaDescription;
  // Read by literal name at request time, like the homepage; unset, no canonical.
  const base = siteOrigin({ APP_ORIGIN: process.env.APP_ORIGIN });
  return {
    ...(base ? { metadataBase: new URL(base), alternates: { canonical: "/pricing" } } : {}),
    title: { absolute: title },
    description,
    openGraph: {
      type: "website",
      siteName: t.brand.name,
      title,
      description,
      locale: { en: "en_US", ru: "ru_RU", uz: "uz_UZ" }[locale],
      images: [{ ...OG_IMAGE, alt: t.landing.meta.ogAlt }],
      ...(base ? { url: "/pricing" } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [{ url: OG_IMAGE.url, alt: t.landing.meta.ogAlt }],
    },
  };
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
  let ratesFailed = false;
  if (supabase && user) {
    const res = await readCreditPrices(supabase);
    // A failed read is no rates at all — not an empty price list — and the
    // page says it could not read them, which is not "not published yet".
    if (res.supported && !res.failed) rates = creditRates(res.prices);
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
        plansFailed={catalogRead.state === "failed"}
        plans={plans}
        packValidMonths={catalog?.packValidMonths}
      />
    </PublicShell>
  );
}
