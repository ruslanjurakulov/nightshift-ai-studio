import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { getLegalTexts } from "@/lib/legal-docs";
import { runtimeSiteOrigin, shareMetadata } from "@/lib/landing";
import { REFUND_PATH } from "@/lib/public-paths";
import { PublicShell } from "@/components/legal/PublicShell";
import { LegalDocumentView } from "@/components/legal/LegalDocumentView";

/** Public: middleware lets this path through signed out (lib/public-paths.ts LEGAL_PATHS). */
export async function generateMetadata(): Promise<Metadata> {
  const { locale, t } = await getDictionary();
  const doc = getLegalTexts(locale).refund;
  const title = `${doc.title} · ${t.brand.name}`;
  // Canonical, OpenGraph and the Twitter card through the helper every other public page uses.
  return {
    title,
    description: doc.summary,
    ...shareMetadata({
      origin: runtimeSiteOrigin(),
      path: REFUND_PATH,
      title,
      description: doc.summary,
      siteName: t.brand.name,
      imageAlt: t.landing.meta.ogAlt,
      locale,
    }),
  };
}

/**
 * The Refund Policy Paddle's seller verification asks for as a page of its own.
 * It restates Terms section 8 and is rendered by the same view as /terms and
 * /privacy, so the operator details, the effective date and the "not published
 * yet" placeholders behave exactly as they do there.
 */
export default async function RefundPage() {
  const { locale, t } = await getDictionary();
  return (
    <PublicShell t={t}>
      <LegalDocumentView doc={getLegalTexts(locale).refund} t={t} locale={locale} />
    </PublicShell>
  );
}
