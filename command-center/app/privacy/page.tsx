import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { getLegalTexts } from "@/lib/legal-docs";
import { runtimeSiteOrigin, shareMetadata } from "@/lib/landing";
import { PublicShell } from "@/components/legal/PublicShell";
import { LegalDocumentView } from "@/components/legal/LegalDocumentView";

/** Public: middleware lets this path through signed out (lib/public-paths.ts). */
export async function generateMetadata(): Promise<Metadata> {
  const { locale, t } = await getDictionary();
  const doc = getLegalTexts(locale).privacy;
  const title = `${doc.title} · ${t.brand.name}`;
  // Canonical, OpenGraph and the Twitter card through the helper every other public page uses.
  return {
    title,
    description: doc.summary,
    ...shareMetadata({
      origin: runtimeSiteOrigin(),
      path: "/privacy",
      title,
      description: doc.summary,
      siteName: t.brand.name,
      imageAlt: t.landing.meta.ogAlt,
      locale,
    }),
  };
}

export default async function PrivacyPage() {
  const { locale, t } = await getDictionary();
  return (
    <PublicShell t={t}>
      <LegalDocumentView doc={getLegalTexts(locale).privacy} t={t} locale={locale} />
    </PublicShell>
  );
}
