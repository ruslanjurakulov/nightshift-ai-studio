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
  // chosen, and a sidebar tool row opens that tool. Either only fills the
  // form: nothing is priced or spent until Generate is pressed.
  const q = await searchParams;
  const initial = prefillFromQuery(q.tool, q.source);
  const operator = await isOperator();

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="studio" title={t.create.title} subtitle={t.create.subtitle} />
      {/* Keyed by the link's tool and picture: moving between the sidebar's
          tool rows is a client navigation to the same page, and without a new
          key the panel would keep the tool it already had. */}
      {genOrgId && (
        <GenerateSection
          key={`${initial?.capability ?? ""}:${initial?.sourceId ?? ""}`}
          orgId={genOrgId}
          models={models}
          initial={initial}
          // The channel's look (0047) is the starting style; the panel uses it
          // only if it is one of the organization's kits as loaded.
          defaultStyleKitId={typeof scopedChannel?.default_style_kit_id === "string" ? scopedChannel.default_style_kit_id : null}
          // The platform operator has no phone tab bar to dock Generate above.
          bottomBar={!operator}
        />
      )}
      <CreateStudio
        channelId={scopedChannel?.channel_id ?? null}
        githubConfigured={isRunNowConfigured}
        backend={runBackend}
        agentConfig={scopedChannel?.agent_config ?? null}
        canRun={canRun}
        operator={operator}
        targets={targets}
      />
    </div>
  );
}
