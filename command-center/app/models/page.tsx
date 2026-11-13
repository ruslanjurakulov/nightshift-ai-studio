import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { runtimeSiteOrigin, shareMetadata } from "@/lib/landing";
import { MODELS_PATH } from "@/lib/public-paths";
import { PublicShell } from "@/components/legal/PublicShell";
import { ModelIndexView } from "@/components/site/ModelPages";
import { MODEL_PAGES } from "@/components/site/model-catalog";

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getDictionary();
  const m = t.site.modelPages.meta;
  return {
    title: { absolute: m.indexTitle },
    description: m.indexDescription,
    ...shareMetadata({
      origin: runtimeSiteOrigin(),
      path: MODELS_PATH,
      title: m.indexTitle,
      description: m.indexDescription,
      siteName: t.brand.name,
      imageAlt: t.landing.meta.ogAlt,
      locale,
    }),
  };
}

/**
 * /models: the models that made the site's samples (components/site/model-catalog.ts). Public for a signed-out visitor
 * (lib/public-paths.ts MODELS_PATH); a signed-in request for it is the old link to the app's Models section and never reaches
 * this page.
 */
export default async function ModelsRoute() {
  const { t } = await getDictionary();
  return (
    <PublicShell t={t} fresh>
      <ModelIndexView t={t} pages={MODEL_PAGES} />
    </PublicShell>
  );
}
