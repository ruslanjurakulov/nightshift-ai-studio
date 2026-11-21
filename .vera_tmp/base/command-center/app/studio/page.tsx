import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { runtimeSiteOrigin, shareMetadata } from "@/lib/landing";
import { STUDIO_PAGE_PATH } from "@/lib/public-paths";
import { PublicShell } from "@/components/legal/PublicShell";
import { StudioPage } from "@/components/site/StudioPage";

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getDictionary();
  const m = t.site.studioPage.meta;
  // Canonical, OpenGraph and the Twitter card through the one helper the other public pages use, so the image is the
  // existing /og.png. One URL serves all three languages (the language is the visitor's cookie or browser setting), so
  // there are no per-language alternates to declare: no hreflang is emitted, rather than three links to one address.
  return {
    title: { absolute: m.title },
    description: m.description,
    ...shareMetadata({
      origin: runtimeSiteOrigin(),
      path: STUDIO_PAGE_PATH,
      title: m.title,
      description: m.description,
      siteName: t.brand.name,
      imageAlt: t.landing.meta.ogAlt,
      locale,
    }),
  };
}

/** /studio: what you can make and edit. Public for a signed-out visitor (lib/public-paths.ts STUDIO_PAGE_PATH); a signed-in request for it is the old section link and never reaches this page. */
export default async function StudioRoute() {
  const { t } = await getDictionary();
  return (
    <PublicShell t={t} current="studio" fresh>
      <StudioPage t={t} />
    </PublicShell>
  );
}
