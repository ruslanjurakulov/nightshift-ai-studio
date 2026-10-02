import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { getLegalTexts } from "@/lib/legal-docs";
import { PublicShell } from "@/components/legal/PublicShell";
import { LegalDocumentView } from "@/components/legal/LegalDocumentView";
import { CREDIT_EXPIRY_MONTHS } from "@/lib/legal";
import { packExpiry } from "@/lib/plans";
import { readPublicPlanCatalog } from "@/lib/server/public-catalog";

/** Public: middleware lets this path through signed out (lib/public-paths.ts). */
export async function generateMetadata(): Promise<Metadata> {
  const { locale, t } = await getDictionary();
  const doc = getLegalTexts(locale).terms;
  return { title: `${doc.title} · ${t.brand.name}`, description: doc.summary };
}

/**
 * Section 8.5 states the top-up credit expiry from the same source as /pricing
 * and the landing (BR-L-130): the plan catalog's pack policy (the shared,
 * bounded public read), else NEXT_PUBLIC_CREDITS_EXPIRY_MONTHS. A catalog that
 * cannot be read gives "unknown", never a "do not expire" the database may
 * contradict.
 */
export default async function TermsPage() {
  const { locale, t } = await getDictionary();
  const expiry = packExpiry(await readPublicPlanCatalog(), CREDIT_EXPIRY_MONTHS);
  return (
    <PublicShell t={t}>
      <LegalDocumentView doc={getLegalTexts(locale).terms} t={t} locale={locale} expiry={expiry} />
    </PublicShell>
  );
}
