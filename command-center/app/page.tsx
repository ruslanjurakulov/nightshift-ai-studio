import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ALL_CHANNELS_SLUG } from "@/lib/channels";
import { getUser } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { PublicShell } from "@/components/legal/PublicShell";
import { Landing } from "@/components/landing/Landing";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getDictionary();
  return { title: `${t.brand.name} · ${t.landing.eyebrow}`, description: t.landing.lead };
}

/**
 * "/" is two pages. Signed out, it is the public landing page. Signed in, it
 * names neither a channel nor a screen, so it stands for nothing and sends you
 * on — in practice the middleware has already redirected to the channel you
 * last viewed before routing gets here; this is the fallback for when it did
 * not run, and lands on every channel's Command Center.
 */
export default async function Home() {
  if (await getUser()) redirect(`/${ALL_CHANNELS_SLUG}/command-center`);

  const { t } = await getDictionary();
  return (
    <PublicShell t={t}>
      <Landing t={t} />
    </PublicShell>
  );
}
