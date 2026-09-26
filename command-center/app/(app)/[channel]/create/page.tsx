import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelContext } from "@/lib/channels-server";
import { isScoped } from "@/lib/channels";
import { isRunNowConfigured, runBackend } from "@/lib/server/run-backend";
import { CreateStudio } from "@/components/create/CreateStudio";
import { resolveCurrentOrgRole } from "@/lib/auth/org-roles";
import { atLeast } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function CreatePage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const { selection, channels } = await getChannelContext();
  const scopedChannel = isScoped(selection)
    ? channels.find((c) => c.channel_id === selection)
    : undefined;
  // Run now is an owner/admin action in the channel's organization.
  const canRun = atLeast(await resolveCurrentOrgRole(), "admin");

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="studio" title={t.create.title} subtitle={t.create.subtitle} />
      <CreateStudio
        channelId={scopedChannel?.channel_id ?? null}
        githubConfigured={isRunNowConfigured}
        backend={runBackend}
        agentConfig={scopedChannel?.agent_config ?? null}
        canRun={canRun}
      />
    </div>
  );
}
