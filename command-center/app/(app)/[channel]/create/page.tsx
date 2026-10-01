import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelContext } from "@/lib/channels-server";
import { isScoped } from "@/lib/channels";
import { isRunNowConfigured, runBackend } from "@/lib/server/run-backend";
import { CreateStudio } from "@/components/create/CreateStudio";
import { isOperator, resolveCurrentOrgRole } from "@/lib/auth/org-roles";
import { atLeast } from "@/lib/auth/roles";
import { readConnectedAccounts } from "@/lib/connectedAccounts";
import { getOrgContext } from "@/lib/orgs-server";
import { loadStudioModels } from "@/lib/server/creative";
import { GenerateSection } from "@/components/studio/GenerateSection";
import { prefillFromQuery } from "@/lib/creative/studio";
import { runPrefillFromQuery, toolPrefill } from "@/lib/home";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function CreatePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const { selection, channels } = await getChannelContext();
  const scopedChannel = isScoped(selection)
    ? channels.find((c) => c.channel_id === selection)
    : undefined;
  // Run now is an owner/admin action in the channel's organization.
  const canRun = atLeast(await resolveCurrentOrgRole(), "admin");
  // "Making this for:" — the organization's connected accounts (RLS, metadata only).
  const targets = (await readConnectedAccounts().catch(() => [])).map(({ platform, id, name, connected }) => ({
    platform,
    id,
    name,
    connected,
  }));
  // Make one image, video or voice (0036) for the open organization; without
  // organizations (0018) or an open one there is nothing to bill, so neither shows.
  const org = await getOrgContext();
  const genOrgId = org.supported && org.current ? org.current.id : null;
  const models = genOrgId ? await loadStudioModels() : [];
  // "Use in Studio" from the Library opens a picture tool with the picture
  // chosen. It only fills the form: nothing is priced or spent until pressed.
  const q = await searchParams;
  // Home's quick tools open a tool with no picture yet (/create?tool=t2i).
  const initial = prefillFromQuery(q.tool, q.source) ?? toolPrefill(q.tool);
  // Home's composer: topic, length and language for the channel run below.
  // Fills the form; Create still shows the price and asks before it runs.
  const runInitial = runPrefillFromQuery(q);

  const run = (
    <CreateStudio
      channelId={scopedChannel?.channel_id ?? null}
      githubConfigured={isRunNowConfigured}
      backend={runBackend}
      agentConfig={scopedChannel?.agent_config ?? null}
      canRun={canRun}
      operator={await isOperator()}
      targets={targets}
      initial={runInitial}
    />
  );

  // Arriving from Home with a topic, the run form comes first: that is what
  // was asked for, and its price is the next thing to read.
  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="studio" title={t.create.title} subtitle={t.create.subtitle} />
      {runInitial && run}
      {genOrgId && <GenerateSection orgId={genOrgId} models={models} initial={initial} />}
      {!runInitial && run}
    </div>
  );
}
