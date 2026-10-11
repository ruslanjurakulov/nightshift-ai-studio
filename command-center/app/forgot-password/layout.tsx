import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { runtimeSiteOrigin, shareMetadata } from "@/lib/landing";

/** The page is client code; its title and description live here. */
export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getDictionary();
  const title = `${t.recovery.forgotTitle} · ${t.brand.name}`;
  return {
    title: { absolute: title },
    description: t.recovery.forgotSub,
    ...shareMetadata({
      origin: runtimeSiteOrigin(),
      path: "/forgot-password",
      title,
      description: t.recovery.forgotSub,
      siteName: t.brand.name,
      imageAlt: t.landing.meta.ogAlt,
      locale,
    }),
  };
}

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
