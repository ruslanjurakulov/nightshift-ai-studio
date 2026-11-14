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
import { isOperatorOrg } from "@/lib/channel-tokens";
import { getOrgContext } from "@/lib/orgs-server";
import { loadOperatorPreviewModels, loadStudioModels, loadSwitchedOffModels } from "@/lib/server/creative";
import { loadUpsellCatalog } from "@/lib/server/upsell";
import { GenerateSection } from "@/components/studio/GenerateSection";
import { prefillFromQuery, withPreviews } from "@/lib/creative/studio";
import { cleanLinkPrompt, parseIdParam, prefillFromImprove } from "@/lib/creative/improve";
import { PENDING_PARAM, PENDING_VALUE } from "@/lib/site/prompt-link";
import { runPrefillFromQuery, runnableChannels, toolPrefill } from "@/lib/home";
import { presetPrefill } from "@/lib/presets";
import { StudioHome, type AssistantData } from "@/components/studio/StudioHome";
import { channelDnaForCreate } from "@/lib/server/channel-dna";
import { startStyleKitId } from "@/lib/styles/add";
import { parseStyleId } from "@/lib/style-kits";
import { prefillModel } from "@/lib/models-discovery";
import { deskFromQuery, isMediaDesk } from "@/lib/creative/desks";
import { DeskBar, YouTubeDesk, type CreditsReading, type ProjectsReading } from "@/components/studio/Desks";
import { createClient, getUser } from "@/lib/supabase/server";
import { readCreditAccount } from "@/lib/server/credits";
import { loadEditorProjects } from "@/lib/server/editor";
import { effectFromQuery, effectPrefill, resolveEffect } from "@/lib/effects/catalog";
import { EffectBanner } from "@/components/effects/EffectBanner";
import { EffectsDesk } from "@/components/effects/EffectsDesk";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

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
  const [models, plans, switchedOff] = genOrgId
    ? await Promise.all([loadStudioModels(genOrgId), loadUpsellCatalog(genOrgId), loadSwitchedOffModels()])
    : [[], null, [] as string[]];
  // "Use in Studio" from the Library opens a picture tool with the picture
  // chosen, and a sidebar tool row opens that tool. Either only fills the
  // form: nothing is priced or spent until Generate is pressed.
  const q = await searchParams;
  // Home's quick tools open a tool with no picture yet (/create?tool=t2i).
  // Channel DNA (0056): the scoped channel's look and voice start both forms.
  const dna = await channelDnaForCreate(scopedChannel);
  // "Use in Studio" from the Models catalog (/create?tool=t2v&model=<id>) also picks
  // that model — shape-checked here; the panel keeps it only if it offers it for the tool.
  // The Presets gallery adds a template or a voice (lib/presets): it fills the same form.
  // "Improve with AI" (lib/creative/improve) adds `model=auto` and the words typed in its panel: they only fill the form.
  const initial = prefillFromImprove(
    prefillModel(presetPrefill(dna.withStudio(prefillFromQuery(q.tool, q.source) ?? toolPrefill(q.tool)), q), q.model),
    q,
  );
  // Home's composer: topic, length and language for the channel run below.
  // Fills the form; Create still shows the price and asks before it runs.
  const runInitial = runPrefillFromQuery(q);
  const operator = await isOperator();
  // 0139: the platform operator, in the operator's own organization only, may also try a hidden model marked operator_preview. The
  // database answers no rows to anyone else; asking only here keeps every customer's page exactly as it was (one call fewer, too).
  // Only the generate panel gets them: the Assistant's plans and the automatic pick stay on the models that are on sale.
  const previews = operator && isOperatorOrg(genOrgId) && genOrgId ? await loadOperatorPreviewModels(genOrgId) : [];
  // Both generate boxes get them: the overview's composer is the first one the operator meets, and without the previews it read
  // "no model can do this" while the Image desk offered the model. The Assistant below keeps `models`, the ones on sale.
  const panelModels = withPreviews(models, previews);
  // An effect (lib/effects/catalog.ts, /create?tool=t2v&effect=<id>) fills the same form with its words, shape, length and the
  // first of its models that this workspace is offered — the same list the panel gets, previews included only for the operator.
  // With none of its models offered it fills nothing and the banner says so; it is never pointed at another model.
  const effectAsk = genOrgId ? effectFromQuery(q) : null;
  const effectPick = effectAsk ? resolveEffect(effectAsk.effect, panelModels) : null;
  const formInitial =
    effectAsk && effectPick?.state === "ready"
      ? effectPrefill(effectAsk.effect, effectPick.modelId, effectAsk.subject, effectAsk.sourceId)
      : initial;
  // Whose create attempt this is: with the id the idempotency key survives a reload of the tab (as a hash only).
  const user = await getUser();
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
      userId={user?.id ?? ""}
      orgId={genOrgId}
    />
  );

  // The Assistant: one goal → a priced plan → one confirm, built on the two
  // halves of this page (Run now and the generate panel). On the overview it is
  // the composer's Plan toggle; the client renders it from this data.
  const assistant: AssistantData = {
    orgId: genOrgId,
    models,
    channels: runnableChannels(channels).map((c) => ({
      id: c.channel_id,
      slug: channelSlug(c, channels),
      name: c.name || c.channel_id,
      language: typeof c.agent_config?.language === "string" ? c.agent_config.language : "",
    })),
    currentSlug: scopedChannel ? channelSlug(scopedChannel, channels) : null,
    canRun,
    runConfigured: isRunNowConfigured,
  };
  // Which desk (lib/creative/desks): ?desk= when it names one, else the tool's
  // desk, else the YouTube run when Home handed over a topic, else the overview.
  // A desk only arranges the page: every price, hold and create call is the same.
  const desk = deskFromQuery({ desk: q.desk, tool: q.tool, hasRunPrefill: !!runInitial });

  // The overview's side panels, read as the member (RLS) and only on the overview.
  // Unreadable is unknown, never a zero; the operator's own organization is not charged.
  let credits: CreditsReading = { state: "unknown" };
  let projects: ProjectsReading = { state: "not_available" };
  if (desk === "overview" && org.supported && org.current) {
    const orgId = org.current.id;
    const supabase = await createClient();
    const [account, list] = await Promise.all([
      org.current.is_default || !supabase ? Promise.resolve(null) : readCreditAccount(supabase, orgId).catch(() => null),
      loadEditorProjects(orgId),
    ]);
    credits = org.current.is_default ? { state: "exempt" } : account?.account ? { state: "account", account: account.account } : { state: "unknown" };
    projects =
      list.state === "ok"
        ? { state: "ok", projects: list.value.map((p) => ({ id: p.id, title: p.title, updatedAt: p.updatedAt })) }
        : list.state === "not_available"
          ? { state: "not_available" }
          : { state: "failed" };
  }

  return (
    <div className="rhythm stagger-enter ns-open">
      {/* The overview opens on its own question and the box to write in; the full pages keep their header and switcher. */}
      {desk !== "overview" && <PageHeader icon="studio" title={t.create.title} subtitle={t.desk.blurbs[desk]} />}
      {desk !== "overview" && <DeskBar current={desk} />}
      {desk === "overview" && (
        <StudioHome
          orgId={genOrgId}
          models={panelModels}
          unavailable={switchedOff}
          plans={plans}
          defaultStyleKitId={startKit}
          dna={dna.studio}
          bottomBar={!operator}
          initial={initial}
          credits={credits}
          projects={projects}
          assistant={assistant}
          // The public home page's composer kept a file in this browser (lib/site/pending-attachment.ts): the box picks it up once.
          // Its words are cleaned and bounded as any link's (a clip's limit; the tool's own limit applies once the tool is known).
          pending={one(q[PENDING_PARAM]) === PENDING_VALUE ? { words: cleanLinkPrompt("t2v", one(q.prompt)) } : null}
        />
      )}
      {desk === "effects" &&
        (genOrgId ? <EffectsDesk models={panelModels} /> : <p className="studio-field p-4 text-sm text-[var(--color-muted)]">{t.effects.desk.noOrg}</p>)}
      {isMediaDesk(desk) && effectAsk && effectPick && (
        <EffectBanner effect={effectAsk.effect} availability={effectPick} subject={effectAsk.subject} />
      )}
      {isMediaDesk(desk) &&
        effectPick?.state !== "unavailable" &&
        (genOrgId ? (
          // Keyed by the desk and the link's tool and picture: moving between the
          // sidebar's rows is a client navigation to the same page, and without a
          // new key the panel would keep the tool it already had.
          <GenerateSection
            key={`${desk}:${formInitial?.capability ?? ""}:${formInitial?.sourceId ?? ""}:${askedStyle ?? ""}:${formInitial?.model ?? ""}:${formInitial?.auto ? "auto" : ""}:${formInitial?.voiceId ?? ""}:${typeof q.template === "string" ? q.template : ""}:${effectAsk?.effect.id ?? ""}:${formInitial?.prompt ?? ""}`}
            desk={desk}
            orgId={genOrgId}
            models={panelModels}
            // The owner's switch (0124): a model the form came with that is off is named as such, never swapped for another.
            unavailable={switchedOff}
            initial={formInitial}
            // The channel's look (0047) is the starting style; the panel uses it
            // only if it is one of the organization's kits as loaded.
            defaultStyleKitId={startKit}
            dna={dna.studio}
            // The platform operator has no phone tab bar to dock Generate above.
            bottomBar={!operator}
            plans={plans}
            // From an editor project ("Improve with AI"): a finished result can be added back to it.
            project={parseIdParam(q.project)}
          />
        ) : (
          <p className="studio-field p-4 text-sm text-[var(--color-muted)]">{t.desk.noOrg}</p>
        ))}
      {desk === "youtube" && <YouTubeDesk run={run} />}
      {/* The pickers above are filtered by the request's country once a model has a country list: the (app) layout carries the
          DB-IP credit for every page (docs/GEO_BLOCK.md). */}
    </div>
  );
}
