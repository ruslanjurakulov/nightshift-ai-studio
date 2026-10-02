import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { runtimeSiteOrigin, shareMetadata } from "@/lib/landing";

/** The sign-in page is client code; its title and description live here. */
export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getDictionary();
  const title = `${t.site.auth.signInTitle} · ${t.brand.name}`;
  return {
    title: { absolute: title },
    description: t.site.auth.signInSub,
    ...shareMetadata({
      origin: runtimeSiteOrigin(),
      path: "/login",
      title,
      description: t.site.auth.signInSub,
      siteName: t.brand.name,
      imageAlt: t.landing.meta.ogAlt,
      locale,
    }),
  };
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
