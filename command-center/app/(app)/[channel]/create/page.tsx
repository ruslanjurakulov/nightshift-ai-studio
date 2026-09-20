import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelContext } from "@/lib/channels-server";
import { isScoped } from "@/lib/channels";
import { isGithubConfigured } from "@/lib/server/github-secrets";
import { CreateStudio } from "@/components/create/CreateStudio";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function CreatePage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const { selection, channels } = await getChannelContext();
  const scopedChannel = isScoped(selection)
    ? channels.find((c) => c.channel_id === selection)
    : undefined;

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="studio" title={t.create.title} subtitle={t.create.subtitle} />
      <CreateStudio
        channelId={scopedChannel?.channel_id ?? null}
        githubConfigured={isGithubConfigured}
        agentConfig={scopedChannel?.agent_config ?? null}
      />
    </div>
  );
}
