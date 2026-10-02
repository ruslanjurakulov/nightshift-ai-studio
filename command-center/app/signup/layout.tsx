import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";

/** The sign-up page is client code; its title and description live here. */
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getDictionary();
  return {
    title: { absolute: `${t.signup.title} · ${t.brand.name}` },
    description: t.signup.sub,
    openGraph: { title: `${t.signup.title} · ${t.brand.name}`, description: t.signup.sub, images: [{ url: "/og.png", width: 1200, height: 630 }] },
  };
}

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
