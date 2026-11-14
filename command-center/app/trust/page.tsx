import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { runtimeSiteOrigin, shareMetadata } from "@/lib/landing";
import { TRUST_PATH } from "@/lib/public-paths";
import { PublicShell } from "@/components/legal/PublicShell";
import { TrustPage } from "@/components/site/TrustPage";

/** Public to everyone, signed in or out (lib/public-paths.ts TRUST_PATH, in ALWAYS_PUBLIC_PATHS). */
export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getDictionary();
  const m = t.site.trust.meta;
  return {
    title: { absolute: m.title },
    description: m.description,
    ...shareMetadata({
      origin: runtimeSiteOrigin(),
      path: TRUST_PATH,
      title: m.title,
      description: m.description,
      siteName: t.brand.name,
      imageAlt: t.landing.meta.ogAlt,
      locale,
    }),
  };
}

/** /trust: what Nightshift may do with a channel, keys and money, and how to report a problem. */
export default async function TrustRoute() {
  const { t, locale } = await getDictionary();
  return (
    <PublicShell t={t} fresh>
      <TrustPage t={t} locale={locale} origin={runtimeSiteOrigin()} />
    </PublicShell>
  );
}
