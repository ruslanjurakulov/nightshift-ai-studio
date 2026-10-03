import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary } from "@/lib/i18n/server";
import { runtimeSiteOrigin, shareMetadata } from "@/lib/landing";
import { SOLUTION_IDS, isSolutionId, solutionHref } from "@/lib/solutions";
import { PublicShell } from "@/components/legal/PublicShell";
import { SolutionView } from "@/components/site/SolutionView";

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
  const path = solutionHref(slug);
  return {
    title: { absolute: title },
    description: page.lead,
    ...shareMetadata({
      origin: runtimeSiteOrigin(),
      path,
      title,
      description: page.lead,
      siteName: t.brand.name,
      imageAlt: t.landing.meta.ogAlt,
      locale,
    }),
  };
}

export default async function SolutionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isSolutionId(slug)) notFound();
  const { t } = await getDictionary();
  const page = t.site.solutions.pages.find((p) => p.id === slug);
  if (!page) notFound();
  return (
    <PublicShell t={t} current="solutions" fresh>
      <SolutionView t={t} id={slug} page={page} />
    </PublicShell>
  );
}
