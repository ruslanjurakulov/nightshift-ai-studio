import { notFound } from "next/navigation";
import { customVoiceEnabled } from "@/lib/custom-voice";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { CustomVoice } from "@/components/voice/CustomVoice";
import { getDictionary } from "@/lib/i18n/server";
import { getChannelContext } from "@/lib/channels-server";
import { getOrgContext } from "@/lib/orgs-server";
import { isScoped } from "@/lib/channels";
import "../../../app-pages-g2.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Custom voice (slice V3, docs/CUSTOM_VOICE.md): dark unless CUSTOM_VOICE_ENABLED=1.
 *
 * The flag is the FIRST statement, before the dictionary, the channel context, the organization or any Supabase client: a request
 * with the flag off is the public 404 and asks the database nothing. The middleware answers that 404 even earlier (lib/custom-voice.ts
 * customVoiceDecision), so this line is the second lock, for a request that ever got past the first. Everything on the page after
 * it runs in the browser with the signed-in person's own session: the page reads and writes nothing itself.
 */
export default async function CustomVoicePage() {
  if (!customVoiceEnabled()) notFound();
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const { selection, channels } = await getChannelContext();
  const channelId = isScoped(selection) ? (channels.find((c) => c.channel_id === selection)?.channel_id ?? null) : null;
  const org = await getOrgContext();

  return (
    <div className="rhythm ns-open">
      <PageHeader icon="agents" title={t.customVoice.title} subtitle={t.customVoice.subtitle} />
      <CustomVoice channelId={channelId} orgId={org.current?.id ?? null} />
    </div>
  );
}
