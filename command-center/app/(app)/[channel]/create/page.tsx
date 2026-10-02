import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelContext } from "@/lib/channels-server";
import { channelSlug, isScoped } from "@/lib/channels";
import { isRunNowConfigured, runBackend } from "@/lib/server/run-backend";
import { CreateStudio } from "@/components/create/CreateStudio";
import { isOperator, resolveCurrentOrgRole } from "@/lib/auth/org-roles";
import { atLeast } from "@/lib/auth/roles";
import { readConnectedAccounts } from "@/lib/connectedAccounts";
import { getOrgContext } from "@/lib/orgs-server";
import { loadStudioModels } from "@/lib/server/creative";
import { loadUpsellCatalog } from "@/lib/server/upsell";
import { GenerateSection } from "@/components/studio/GenerateSection";
import { prefillFromQuery } from "@/lib/creative/studio";
import { runPrefillFromQuery, runnableChannels, toolPrefill } from "@/lib/home";
import { AssistantPlanner } from "@/components/assistant/AssistantPlanner";
import { channelDnaForCreate } from "@/lib/server/channel-dna";
import { startStyleKitId } from "@/lib/styles/add";
import { parseStyleId } from "@/lib/style-kits";
import { prefillModel } from "@/lib/models-discovery";

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
  // The plan dialog's catalog (0034) is read beside the models: a refused
  // generation then names the plans that unlock it without another round trip.
  const [models, plans] = genOrgId ? await Promise.all([loadStudioModels(), loadUpsellCatalog(genOrgId)]) : [[], null];
  // "Use in Studio" from the Library opens a picture tool with the picture
  // chosen, and a sidebar tool row opens that tool. Either only fills the
  // form: nothing is priced or spent until Generate is pressed.
  const q = await searchParams;
  // Home's quick tools open a tool with no picture yet (/create?tool=t2i).
  // Channel DNA (0056): the scoped channel's look and voice start both forms.
  const dna = await channelDnaForCreate(scopedChannel);
  // "Use in Studio" from the Models catalog (/create?tool=t2v&model=<id>) also picks
  // that model — shape-checked here; the panel keeps it only if it offers it for the tool.
  const initial = prefillModel(dna.withStudio(prefillFromQuery(q.tool, q.source) ?? toolPrefill(q.tool)), q.model);
  // Home's composer: topic, length and language for the channel run below.
  // Fills the form; Create still shows the price and asks before it runs.
  const runInitial = runPrefillFromQuery(q);
  const operator = await isOperator();
  // "Use in Studio" from the Style Library (/create?tool=t2i&style=<kit>) picks that
  // kit as the starting style — fills the chip, nothing more. The panel keeps it only
  // if it is one of the organization's kits as loaded, so a stale or foreign id reads
  // as "None". Without it, the channel's own default look starts the form.
  const askedStyle = typeof q.style === "string" ? parseStyleId(q.style) : null;
  const startKit = startStyleKitId(askedStyle, scopedChannel?.default_style_kit_id);

  const run = (
    <CreateStudio
      channelId={scopedChannel?.channel_id ?? null}
      githubConfigured={isRunNowConfigured}
      backend={runBackend}
      agentConfig={scopedChannel?.agent_config ?? null}
      canRun={canRun}
      operator={operator}
      targets={targets}
      initial={runInitial}
      dna={dna.run}
    />
  );

  // The Assistant: one goal → a priced plan → one confirm, built on the two
  // halves of this page (Run now and the generate panel). Opened with a
  // prefill (a tool, a picture, a topic), what was asked for comes first.
  const assistant = (
    <AssistantPlanner
      orgId={genOrgId}
      models={models}
      channels={runnableChannels(channels).map((c) => ({
        id: c.channel_id,
        slug: channelSlug(c, channels),
        name: c.name || c.channel_id,
        language: typeof c.agent_config?.language === "string" ? c.agent_config.language : "",
      }))}
      currentSlug={scopedChannel ? channelSlug(scopedChannel, channels) : null}
      canRun={canRun}
      runConfigured={isRunNowConfigured}
    />
  );
  const prefilled = !!runInitial || !!initial;

  // Arriving from Home with a topic, the run form comes first: that is what
  // was asked for, and its price is the next thing to read.
  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="studio" title={t.create.title} subtitle={t.create.subtitle} />
      {!prefilled && assistant}
      {runInitial && run}
      {/* Keyed by the link's tool and picture: moving between the sidebar's
          tool rows is a client navigation to the same page, and without a new
          key the panel would keep the tool it already had. */}
      {genOrgId && (
        <GenerateSection
          key={`${initial?.capability ?? ""}:${initial?.sourceId ?? ""}:${askedStyle ?? ""}:${initial?.model ?? ""}`}
          orgId={genOrgId}
          models={models}
          initial={initial}
          // The channel's look (0047) is the starting style; the panel uses it
          // only if it is one of the organization's kits as loaded.
          defaultStyleKitId={startKit}
          dna={dna.studio}
          // The platform operator has no phone tab bar to dock Generate above.
          bottomBar={!operator}
          plans={plans}
        />
      )}
      {!runInitial && run}
      {prefilled && assistant}
    </div>
  );
}
