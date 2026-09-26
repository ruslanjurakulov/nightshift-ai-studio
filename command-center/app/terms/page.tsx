import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { getLegalTexts } from "@/lib/legal-docs";
import { PublicShell } from "@/components/legal/PublicShell";
import { LegalDocumentView } from "@/components/legal/LegalDocumentView";

/** Public: middleware lets this path through signed out (lib/public-paths.ts). */
export async function generateMetadata(): Promise<Metadata> {
  const { locale, t } = await getDictionary();
  const doc = getLegalTexts(locale).terms;
  return { title: `${doc.title} · ${t.brand.name}`, description: doc.summary };
}

export default async function TermsPage() {
  const { locale, t } = await getDictionary();
  return (
    <PublicShell t={t}>
      <LegalDocumentView doc={getLegalTexts(locale).terms} t={t} locale={locale} />
    </PublicShell>
  );
}
