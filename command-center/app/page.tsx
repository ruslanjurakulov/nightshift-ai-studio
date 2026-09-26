import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ALL_CHANNELS_SLUG } from "@/lib/channels";
import { getUser } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { paddleConfig } from "@/lib/paddle";
import { PRICING_ENV, resolvePricing } from "@/lib/pricing";
import {
  SHOWCASE,
  jsonLdScript,
  pricingTeaser,
  siteOrigin,
  softwareApplicationJsonLd,
  visibleShowcase,
} from "@/lib/landing";
import { PublicShell } from "@/components/legal/PublicShell";
import { Landing } from "@/components/landing/Landing";

/** Read by literal name at request time — a self-hosted deploy sets APP_ORIGIN
 *  in the container, not at build. */
function origin(): string | null {
  return siteOrigin({
    APP_ORIGIN: process.env.APP_ORIGIN,
    VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  });
}

/** Served by app/og.png/route.tsx; see there for why it is not opengraph-image.tsx. */
const OG_IMAGE = { url: "/og.png", width: 1200, height: 630, type: "image/png" };

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getDictionary();
  const m = t.landing.meta;
  const base = origin();
  return {
    // Without a known origin a canonical or og:url would be resolved against
    // localhost, which is worse than leaving them out.
    ...(base ? { metadataBase: new URL(base), alternates: { canonical: "/" } } : {}),
    title: { absolute: m.title },
    description: m.description,
    openGraph: {
      type: "website",
      siteName: t.brand.name,
      title: m.title,
      description: m.description,
      locale: { en: "en_US", ru: "ru_RU", uz: "uz_UZ" }[locale],
      images: [{ ...OG_IMAGE, alt: m.ogAlt }],
      ...(base ? { url: "/" } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: m.title,
      description: m.description,
      images: [{ url: OG_IMAGE.url, alt: m.ogAlt }],
    },
  };
}

/**
 * "/" is two pages. Signed out, it is the public landing page. Signed in, it
 * names neither a channel nor a screen, so it stands for nothing and sends you
 * on — in practice the middleware has already redirected to the channel you
 * last viewed before routing gets here; this is the fallback for when it did
 * not run, and lands on every channel's Command Center.
 */
export default async function Home() {
  if (await getUser()) redirect(`/${ALL_CHANNELS_SLUG}/command-center`);

  const { t, locale } = await getDictionary();
  // The same pricing source /pricing reads; the teaser only ever shows what it holds.
  const pricing = pricingTeaser(resolvePricing(PRICING_ENV, paddleConfig));
  const jsonLd = softwareApplicationJsonLd({
    name: t.brand.name,
    description: t.landing.meta.description,
    url: origin(),
  });

  return (
    <PublicShell t={t}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      <Landing t={t} locale={locale} pricing={pricing} showcase={visibleShowcase(SHOWCASE)} />
    </PublicShell>
  );
}
