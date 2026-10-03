import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/config";
import { getChannelPath } from "@/lib/channels-path-server";
import { NotConfigured } from "@/components/NotConfigured";
import { AddChannelWizard } from "@/components/channels/AddChannelWizard";
import { getDictionary } from "@/lib/i18n/server";
import { getOrgContext } from "@/lib/orgs-server";
import { readChannelPrefill } from "@/lib/welcome";
import { resolveCurrentOrgRole } from "@/lib/auth/org-roles";
import { atLeast } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function NewChannelPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isSupabaseConfigured) return <NotConfigured />;
  // What the person answered on /welcome, if they came from there.
  const prefill = readChannelPrefill(await searchParams);
  const { t } = await getDictionary();
  const path = await getChannelPath();
  const org = await getOrgContext();
  // The operator's own organization confirms its channels from the lookup in
  // this wizard (the database stamps it, migration 0086). Anyone else's channel
  // is confirmed by connecting YouTube on the Channels page.
  const canConfirm = Boolean(
    org.supported && org.current?.is_default && atLeast(await resolveCurrentOrgRole(), "admin"),
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div>
        <Link
          href={path("/channels")}
          className="tap-link text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          ← {t.channels.title}
        </Link>
        <h1 className="t-hero mt-2">{t.channels.newTitle}</h1>
        <p className="t-lead mt-4">{t.channels.newSubtitle}</p>
      </div>
      <AddChannelWizard
        orgId={org.supported ? (org.current?.id ?? null) : null}
        canConfirm={canConfirm}
        initialNiche={prefill.niche}
        initialLanguage={prefill.language}
      />
    </div>
  );
}
