import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ALL_CHANNELS_SLUG } from "@/lib/channels";
import { getUser } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { packExpiry } from "@/lib/plans";
import { sitePlanMatrix, sitePricing } from "@/lib/server/payments";
import { planValue } from "@/lib/server/plans";
import { readPublicPlanCatalog } from "@/lib/server/public-catalog";
import { CREDIT_EXPIRY_MONTHS } from "@/lib/legal";
import {
  SHOWCASE,
  jsonLdScript,
  moneyAnchor,
  pricingTeaser,
  runtimeSiteOrigin,
  shareMetadata,
  siteGraphJsonLd,
  softwareApplicationJsonLd,
  visibleShowcase,
} from "@/lib/landing";
import { readPublicApiPrices } from "@/lib/server/api-prices";
import { readPublicCreditRates } from "@/lib/server/public-rates";
import { readPublicSiteStats } from "@/lib/server/public-stats";
import { PublicShell } from "@/components/legal/PublicShell";
import { Landing } from "@/components/landing/Landing";
import { faqForSale, landingFaqItems } from "@/components/landing/Faq";
import { faqPageJsonLd } from "@/lib/studio-page";

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
  // kept and run together (BR-L-047, BR-L-101). The live counters (0164) are the same kind of read, and null while hidden.
  const [catalogRead, apiPrices, siteRates, liveStats] = await Promise.all([
    readPublicPlanCatalog(),
    readPublicApiPrices(),
    readPublicCreditRates(),
    readPublicSiteStats(),
  ]);
  // An unreadable catalog teases no plans (the pricing page itself says it could not read them).
  const catalog = planValue(catalogRead);
  const resolved = sitePricing();
  const pricing = pricingTeaser(resolved, sitePlanMatrix(catalog, locale));
  const anchor = moneyAnchor(resolved, apiPrices, siteRates);
  const jsonLd = softwareApplicationJsonLd({
    name: t.brand.name,
    description: t.landing.meta.description,
    url: runtimeSiteOrigin(),
  });

  // The questions the page itself shows (Faq.tsx), as the same plain text, so the structured answer cannot differ from the visible one.
  const expiry = packExpiry(catalogRead, CREDIT_EXPIRY_MONTHS);
  const dodo = Boolean(resolved.dodo);
  const faqLd = faqPageJsonLd(faqForSale(landingFaqItems(t.landing.faq, dodo), pricing.kind === "plans", t.site.packsOnly, expiry));
  const graphLd = siteGraphJsonLd({ name: t.brand.name, origin: runtimeSiteOrigin() });

  return (
    <PublicShell t={t} fresh>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      {graphLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(graphLd) }} />}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(faqLd) }} />
      <Landing
        t={t}
        locale={locale}
        pricing={pricing}
        anchor={anchor}
        showcase={visibleShowcase(SHOWCASE)}
        expiry={expiry}
        dodo={dodo}
        liveStats={liveStats}
      />
    </PublicShell>
  );
}
