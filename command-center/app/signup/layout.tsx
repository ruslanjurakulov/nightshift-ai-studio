import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { runtimeSiteOrigin, shareMetadata } from "@/lib/landing";

/** The sign-up page is client code; its title and description live here. */
export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getDictionary();
  const title = `${t.signup.title} · ${t.brand.name}`;
  return {
    title: { absolute: title },
    description: t.signup.sub,
    ...shareMetadata({
      origin: runtimeSiteOrigin(),
      path: "/signup",
      title,
      description: t.signup.sub,
      siteName: t.brand.name,
      imageAlt: t.landing.meta.ogAlt,
      locale,
    }),
  };
}

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
