import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/config";
import { getChannelPath } from "@/lib/channels-path-server";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import "../../../app-pages-g2.css";
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
    <div className="rhythm ns-open mx-auto w-full max-w-3xl">
      <div className="flex flex-col gap-3">
        <Link href={path("/channels")} className="tap-link g2-link w-fit text-sm">
          ← {t.channels.title}
        </Link>
        <PageHeader icon="channels" title={t.channels.newTitle} subtitle={t.channels.newSubtitle} />
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
