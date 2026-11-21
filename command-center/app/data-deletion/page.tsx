import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { getLegalTexts } from "@/lib/legal-docs";
import { runtimeSiteOrigin, shareMetadata } from "@/lib/landing";
import { DATA_DELETION_PATH } from "@/lib/public-paths";
import { PublicShell } from "@/components/legal/PublicShell";
import { LegalDocumentView } from "@/components/legal/LegalDocumentView";

/** Public: middleware lets this path through signed out (lib/public-paths.ts LEGAL_PATHS). */
export async function generateMetadata(): Promise<Metadata> {
  const { locale, t } = await getDictionary();
  const doc = getLegalTexts(locale).dataDeletion;
  const title = `${doc.title} · ${t.brand.name}`;
  return {
    title,
    description: doc.summary,
    ...shareMetadata({
      origin: runtimeSiteOrigin(),
      path: DATA_DELETION_PATH,
      title,
      description: doc.summary,
      siteName: t.brand.name,
      imageAlt: t.landing.meta.ogAlt,
      locale,
    }),
  };
}

/**
 * The data deletion instructions Meta's App Settings require for the Instagram connect (the owner pastes this URL
 * there; docs/SOCIAL_SETUP.md). Rendered by the same view as /privacy, so the contact address comes from
 * NEXT_PUBLIC_CONTACT_EMAIL (lib/legal.ts) and reads "not published yet" when it is unset, never an invented one.
 */
export default async function DataDeletionPage() {
  const { locale, t } = await getDictionary();
  return (
    <PublicShell t={t}>
      <LegalDocumentView doc={getLegalTexts(locale).dataDeletion} t={t} locale={locale} />
    </PublicShell>
  );
}
