import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/config";
import { getChannelPath } from "@/lib/channels-path-server";
import { NotConfigured } from "@/components/NotConfigured";
import { AddChannelWizard } from "@/components/channels/AddChannelWizard";
import { getDictionary } from "@/lib/i18n/server";
import { getOrgContext } from "@/lib/orgs-server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function NewChannelPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const path = await getChannelPath();
  const org = await getOrgContext();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div>
        <Link
          href={path("/channels")}
          className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          ← {t.channels.title}
        </Link>
        <h1 className="t-hero mt-2">{t.channels.newTitle}</h1>
        <p className="t-lead mt-4">{t.channels.newSubtitle}</p>
      </div>
      <AddChannelWizard orgId={org.supported ? (org.current?.id ?? null) : null} />
    </div>
  );
}
