import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary } from "@/lib/i18n/server";
import { siteOrigin } from "@/lib/landing";
import { SOLUTION_IDS, isSolutionId, solutionHref } from "@/lib/solutions";
import { PublicShell } from "@/components/legal/PublicShell";
import { SolutionView } from "@/components/site/SolutionView";

const OG_IMAGE = { url: "/og.png", width: 1200, height: 630, type: "image/png" };

/** Only the listed solutions exist; anything else under /solutions/ is a 404
 *  (and the auth gate never made it public in the first place). */
export const dynamicParams = false;

export function generateStaticParams() {
  return SOLUTION_IDS.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const { t, locale } = await getDictionary();
  const page = t.site.solutions.pages.find((p) => p.id === slug);
  if (!page || !isSolutionId(slug)) return {};
  const title = `${page.nav} · ${t.site.solutions.meta.title} · ${t.brand.name}`;
  const base = siteOrigin({ APP_ORIGIN: process.env.APP_ORIGIN });
  const path = solutionHref(slug);
  return {
    ...(base ? { metadataBase: new URL(base), alternates: { canonical: path } } : {}),
    title: { absolute: title },
    description: page.lead,
    openGraph: {
      type: "website",
      siteName: t.brand.name,
      title,
      description: page.lead,
      locale: { en: "en_US", ru: "ru_RU", uz: "uz_UZ" }[locale],
      images: [{ ...OG_IMAGE, alt: t.landing.meta.ogAlt }],
      ...(base ? { url: path } : {}),
    },
    twitter: { card: "summary_large_image", title, description: page.lead, images: [{ url: OG_IMAGE.url, alt: t.landing.meta.ogAlt }] },
  };
}

export default async function SolutionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isSolutionId(slug)) notFound();
  const { t } = await getDictionary();
  const page = t.site.solutions.pages.find((p) => p.id === slug);
  if (!page) notFound();
  return (
    <PublicShell t={t} current="solutions">
      <SolutionView t={t} id={slug} page={page} />
    </PublicShell>
  );
}
