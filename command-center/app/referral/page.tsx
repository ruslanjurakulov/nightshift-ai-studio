import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { runtimeSiteOrigin, shareMetadata } from "@/lib/landing";
import { REFERRAL_PATH } from "@/lib/public-paths";
import { readReferralTerms } from "@/lib/server/referrals";
import { getUser } from "@/lib/supabase/server";
import { PublicShell } from "@/components/legal/PublicShell";
import { ReferralTermsPage } from "@/components/site/ReferralTermsPage";

// The numbers are read live (bounded and shared, lib/server/public-read.ts): a change by the operator shows within a minute.
export const dynamic = "force-dynamic";

/** Public to everyone, signed in or out (lib/public-paths.ts REFERRAL_PATH, in ALWAYS_PUBLIC_PATHS). */
export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getDictionary();
  const m = t.referral.page;
  const title = `${m.metaTitle} · ${t.brand.name}`;
  return {
    title: { absolute: title },
    description: m.metaDescription,
    ...shareMetadata({
      origin: runtimeSiteOrigin(),
      path: REFERRAL_PATH,
      title,
      description: m.metaDescription,
      siteName: t.brand.name,
      imageAlt: t.landing.meta.ogAlt,
      locale,
    }),
  };
}

/** /referral: the referral programme's full terms, with today's numbers from the database (migration 0165). */
export default async function ReferralRoute() {
  const { t, locale } = await getDictionary();
  const [read, user] = await Promise.all([readReferralTerms(), getUser().catch(() => null)]);
  return (
    <PublicShell t={t}>
      <ReferralTermsPage t={t} locale={locale} read={read} signedIn={Boolean(user)} />
    </PublicShell>
  );
}
