import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ALL_CHANNELS_SLUG } from "@/lib/channels";
import { getUser } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { paddleClient, paddleConfig } from "@/lib/paddle";
import { PLAN_ENV, packExpiry, planMatrix } from "@/lib/plans";
import { planValue } from "@/lib/server/plans";
import { readPublicPlanCatalog } from "@/lib/server/public-catalog";
import { PRICING_ENV, resolvePricing } from "@/lib/pricing";
import { CREDIT_EXPIRY_MONTHS } from "@/lib/legal";
import {
  SHOWCASE,
  jsonLdScript,
  moneyAnchor,
  pricingTeaser,
  runtimeSiteOrigin,
  shareMetadata,
  softwareApplicationJsonLd,
  visibleShowcase,
} from "@/lib/landing";
import { readPublicApiPrices } from "@/lib/server/api-prices";
import { readPublicCreditRates } from "@/lib/server/public-rates";
import { PublicShell } from "@/components/legal/PublicShell";
import { Landing } from "@/components/landing/Landing";

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getDictionary();
  const m = t.landing.meta;
  return {
    title: { absolute: m.title },
    description: m.description,
    // No known origin, no image or canonical: never a card pointing at localhost.
    ...shareMetadata({
      origin: runtimeSiteOrigin(),
      path: "/",
      title: m.title,
      description: m.description,
      siteName: t.brand.name,
      imageAlt: m.ogAlt,
      locale,
    }),
  };
}

/**
 * "/" is two pages. Signed out, it is the public landing page. Signed in, it
 * names neither a channel nor a screen, so it stands for nothing and sends you
 * on — in practice the middleware has already redirected to the channel you
 * last viewed before routing gets here; this is the fallback for when it did
 * not run, and lands on the first channel (see app/(app)/[channel]/page.tsx).
 */
export default async function Home() {
  if (await getUser()) redirect(`/${ALL_CHANNELS_SLUG}`);

  const { t, locale } = await getDictionary();
  // The same pricing source /pricing reads; the teaser only ever shows what it holds.
  // Plans (0034) come from the public price list in the database. The landing
  // is signed out by now, so all three are the shared public reads: bounded,
  // kept and run together (BR-L-047, BR-L-101).
  const [catalogRead, apiPrices, siteRates] = await Promise.all([
    readPublicPlanCatalog(),
    readPublicApiPrices(),
    readPublicCreditRates(),
  ]);
  // An unreadable catalog teases no plans (the pricing page itself says it could not read them).
  const catalog = planValue(catalogRead);
  const resolved = resolvePricing(PRICING_ENV, paddleConfig);
  const pricing = pricingTeaser(resolved, planMatrix(catalog, PLAN_ENV, paddleClient));
  const anchor = moneyAnchor(resolved, apiPrices, siteRates);
  const jsonLd = softwareApplicationJsonLd({
    name: t.brand.name,
    description: t.landing.meta.description,
    url: runtimeSiteOrigin(),
  });

  return (
    <PublicShell t={t}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      <Landing
        t={t}
        locale={locale}
        pricing={pricing}
        anchor={anchor}
        showcase={visibleShowcase(SHOWCASE)}
        expiry={packExpiry(catalogRead, CREDIT_EXPIRY_MONTHS)}
      />
    </PublicShell>
  );
}
