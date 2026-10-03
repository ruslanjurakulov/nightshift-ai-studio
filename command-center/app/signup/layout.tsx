import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getDictionary } from "@/lib/i18n/server";
import { InvitedProvider } from "@/components/auth/InvitedContext";
import { INVITE_COOKIE, normalizeInviteToken } from "@/lib/friend-invites";
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

/**
 * A visitor who came through a live invite link carries its cookie (set by
 * /i/<token> only after the database said the link is live), and the form says
 * so in one line. The cookie is read here, on the server: the page gets a yes
 * or a no, never the token.
 */
export default async function SignupLayout({ children }: { children: React.ReactNode }) {
  const invited = normalizeInviteToken((await cookies()).get(INVITE_COOKIE)?.value) !== null;
  return <InvitedProvider invited={invited}>{children}</InvitedProvider>;
}
