import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";

/** The sign-in page is client code; its title and description live here. */
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getDictionary();
  return {
    title: { absolute: `${t.site.auth.signInTitle} · ${t.brand.name}` },
    description: t.site.auth.signInSub,
    openGraph: { title: `${t.site.auth.signInTitle} · ${t.brand.name}`, description: t.site.auth.signInSub, images: [{ url: "/og.png", width: 1200, height: 630 }] },
  };
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
