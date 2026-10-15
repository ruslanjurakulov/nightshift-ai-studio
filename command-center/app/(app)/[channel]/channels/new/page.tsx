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
import { atLeast, requireRole } from "@/lib/auth/roles";
import { ConnectStart } from "@/components/channels/ConnectStart";
import { isGoogleOAuthConfigured } from "@/lib/server/google-oauth";
import { isSocialConfigured } from "@/lib/server/social-oauth";
import { isConnectPlatform, parseConnectWord } from "@/lib/connect-picker";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function NewChannelPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const sp = await searchParams;
  // What the person answered on /welcome, if they came from there.
  const prefill = readChannelPrefill(sp);
  // A connect that could not reach the pick screen comes back with one known word.
  const firstOf = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const word = parseConnectWord(firstOf(sp.connect));
  const platform = firstOf(sp.platform);
  const connectResult = word && isConnectPlatform(platform) ? { platform, word } : null;
  const { t } = await getDictionary();
  const path = await getChannelPath();
  const org = await getOrgContext();
  // The operator's own organization confirms its channels from the lookup in
  // this wizard (the database stamps it, migration 0086). Anyone else's channel
  // is confirmed by connecting YouTube on the Channels page.
  const canConfirm = Boolean(
    org.supported && org.current?.is_default && atLeast(await resolveCurrentOrgRole(), "admin"),
  );

  // Who the buttons are offered to. Presentation only: the start routes and the
  // database check again, with the same rule as connecting a channel by hand.
  const role = await resolveCurrentOrgRole();
  const canYoutube = org.current?.is_default
    ? (await requireRole("admin")) !== null
    : atLeast(role, "admin");
  const canSocial = Boolean(org.supported && org.current) && atLeast(role, "editor");

  return (
    <div className="rhythm ns-open mx-auto w-full max-w-3xl">
      <div className="flex flex-col gap-3">
        <Link href={path("/channels")} className="tap-link g2-link w-fit text-sm">
          ← {t.channels.title}
        </Link>
        <PageHeader icon="channels" title={t.channels.newTitle} subtitle={t.channels.newSubtitle} />
      </div>
      <ConnectStart
        canYoutube={Boolean(org.supported && org.current) && canYoutube}
        canSocial={canSocial}
        configured={{
          youtube: isGoogleOAuthConfigured,
          instagram: isSocialConfigured("instagram"),
          tiktok: isSocialConfigured("tiktok"),
        }}
        result={connectResult}
        niche={prefill.niche}
        language={prefill.language}
      />
      <details className="g2-manual">
        <summary className="g2-manual-summary">{t.connectPicker.manualSummary}</summary>
        <p className="g2-note">{t.connectPicker.manualHint}</p>
        <AddChannelWizard
          orgId={org.supported ? (org.current?.id ?? null) : null}
          canConfirm={canConfirm}
          initialNiche={prefill.niche}
          initialLanguage={prefill.language}
        />
      </details>
    </div>
  );
}
