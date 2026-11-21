import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { cookies } from "next/headers";
import { GoogleEnabled } from "@/components/auth/GoogleEnabled";
import { SavedAccountsProvider } from "@/components/auth/saved-accounts-context";
import { readParked } from "@/lib/server/device-accounts";
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

export default async function LoginLayout({ children }: { children: React.ReactNode }) {
  // Only whether an account is parked here, never what it is: the page asks the list route for that.
  const present = readParked(await cookies()).size > 0;
  return (
    <GoogleEnabled>
      <SavedAccountsProvider present={present}>{children}</SavedAccountsProvider>
    </GoogleEnabled>
  );
}
