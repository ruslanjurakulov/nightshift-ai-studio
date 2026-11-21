import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { getDevDictionary, type DevDictionary } from "@/lib/i18n/dev";
import { runtimeSiteOrigin, shareMetadata } from "@/lib/landing";

/** Title, description and share card of a developer page, in the visitor's language. */
export async function devPageMetadata(
  path: string,
  pick: (dev: DevDictionary) => { title: string; description: string },
): Promise<Metadata> {
  const { t, locale } = await getDictionary();
  const meta = pick(getDevDictionary(locale));
  const title = `${meta.title} · ${t.brand.name}`;
  return {
    title: { absolute: title },
    description: meta.description,
    ...shareMetadata({
      origin: runtimeSiteOrigin(),
      path,
      title,
      description: meta.description,
      siteName: t.brand.name,
      imageAlt: t.landing.meta.ogAlt,
      locale,
    }),
  };
}
