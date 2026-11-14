import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary } from "@/lib/i18n/server";
import { jsonLdScript, runtimeSiteOrigin, shareMetadata } from "@/lib/landing";
import { SOLUTION_IDS, isSolutionId, solutionHref } from "@/lib/solutions";
import { faqPageJsonLd } from "@/lib/studio-page";
import { howToJsonLd } from "@/lib/site/autopilot-pillar";
import { readPublicCreditRates } from "@/lib/server/public-rates";
import { PublicShell } from "@/components/legal/PublicShell";
import { SolutionView } from "@/components/site/SolutionView";
import { pillarFaqEntries } from "@/components/site/AutopilotPillar";

/** Only the listed solutions exist; anything else under /solutions/ is a 404
 *  (and the auth gate never made it public in the first place). */
export const dynamicParams = false;

export function generateStaticParams() {
  return SOLUTION_IDS.map((slug) => ({ slug }));
}

/** The channels page is the YouTube Autopilot pillar: its own title and description (components/site/SolutionView.tsx). */
const PILLAR_ID = "youtube-channels";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const { t, locale } = await getDictionary();
  const page = t.site.solutions.pages.find((p) => p.id === slug);
  if (!page || !isSolutionId(slug)) return {};
  const pillar = slug === PILLAR_ID ? t.site.autopilot.pillar.meta : null;
  const title = pillar ? `${pillar.title} · ${t.brand.name}` : `${page.nav} · ${t.site.solutions.meta.title} · ${t.brand.name}`;
  const description = pillar ? pillar.description : page.lead;
  const path = solutionHref(slug);
  // A self-referencing canonical and no hreflang: one URL serves all three languages (the visitor's cookie, then the browser's
  // language), so per-language alternates would be three links to one address (docs/LAUNCH_CHECKLIST.md item 14).
  return {
    title: { absolute: title },
    description,
    ...shareMetadata({
      origin: runtimeSiteOrigin(),
      path,
      title,
      description,
      siteName: t.brand.name,
      imageAlt: t.landing.meta.ogAlt,
      locale,
    }),
  };
}

export default async function SolutionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isSolutionId(slug)) notFound();
  const { t, locale } = await getDictionary();
  const page = t.site.solutions.pages.find((p) => p.id === slug);
  if (!page) notFound();
  const pillar = slug === PILLAR_ID;
  // The pillar's price line reads the published rate the landing reads (0089); unpublished or unreadable, it says so.
  const rates = pillar ? await readPublicCreditRates() : null;
  return (
    <PublicShell t={t} current="solutions" fresh>
      {pillar && (
        <>
          {/* The questions and the three steps exactly as the page prints them, so the structured answer cannot differ. */}
          <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(faqPageJsonLd(pillarFaqEntries(t))) }} />
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: jsonLdScript(howToJsonLd({ name: t.site.autopilot.pillar.meta.title, steps: page.start, inLanguage: locale })),
            }}
          />
        </>
      )}
      <SolutionView t={t} id={slug} page={page} locale={locale} rates={rates} />
    </PublicShell>
  );
}
