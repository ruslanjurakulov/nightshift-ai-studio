import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { runtimeSiteOrigin, shareMetadata } from "@/lib/landing";
import { ROADMAP_PATH } from "@/lib/public-paths";
import { PublicShell } from "@/components/legal/PublicShell";
import { RoadmapPage } from "@/components/site/RoadmapPage";

/** Public to everyone, signed in or out (lib/public-paths.ts ROADMAP_PATH, in ALWAYS_PUBLIC_PATHS). */
export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getDictionary();
  const m = t.site.roadmap.meta;
  // The shared helper gives the canonical, OpenGraph and the Twitter card with the existing /og.png, like /studio.
  return {
    title: { absolute: m.title },
    description: m.description,
    ...shareMetadata({
      origin: runtimeSiteOrigin(),
      path: ROADMAP_PATH,
      title: m.title,
      description: m.description,
      siteName: t.brand.name,
      imageAlt: t.landing.meta.ogAlt,
      locale,
    }),
  };
}

/** /roadmap: what is coming ("Kutilayotgan yangiliklar"). */
export default async function RoadmapRoute() {
  const { t } = await getDictionary();
  return (
    <PublicShell t={t} current="resources" fresh>
      <RoadmapPage t={t} />
    </PublicShell>
  );
}
