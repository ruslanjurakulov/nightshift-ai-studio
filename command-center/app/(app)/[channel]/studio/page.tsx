import Link from "next/link";
import { ArrowLeft, Palette } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NotConfigured } from "@/components/NotConfigured";
import { StudioCanvas } from "@/components/studio-canvas/StudioCanvas";
import { StudioTimeline } from "@/components/studio-timeline/StudioTimeline";
import { LiveView } from "@/components/studio-live/LiveView";
import { parseFilmId } from "@/lib/films";
import { VideosShelf } from "@/components/studio-hub/VideosShelf";
import { ProjectsShelf } from "@/components/studio-hub/ProjectsShelf";
import { isSupabaseConfigured } from "@/lib/config";
import { getDictionary } from "@/lib/i18n/server";
import { getChannelPath, getChannelSlug } from "@/lib/channels-path-server";
import { getChannelContext } from "@/lib/channels-server";
import { isScoped } from "@/lib/channels";
import { getOrgContext } from "@/lib/orgs-server";
import { getUser } from "@/lib/supabase/server";
import { viewingAsOperator } from "@/lib/server/owner-view";
import { isOperatorOrg } from "@/lib/channel-tokens";
import { loadOperatorPreviewModels, loadStudioModels, loadSwitchedOffModels } from "@/lib/server/creative";
import { loadUpsellCatalog } from "@/lib/server/upsell";
import { withPreviews } from "@/lib/creative/studio";
import { canvasEffects } from "@/lib/effects/catalog";
import { NightshiftAiPanel } from "@/components/brain/NightshiftAiPanel";
import { firstNameOf } from "@/lib/owner-console/greeting";
import { aiChatEnv, aiChatOpenFor, ideaNeedsCreate } from "@/lib/brain/flag";
import { redirect } from "next/navigation";
import { channelDnaForCreate } from "@/lib/server/channel-dna";
import { startStyleKitId } from "@/lib/styles/add";
import { filmStudioListed, filmStudioMode, filmStudioOpen } from "@/lib/server/films";
import { STUDIO_SHELVES, shelfFromQuery, type StudioShelf } from "@/lib/studioRoutes";
import "@/components/studio-hub/studio-hub.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Nightshift Studio (docs/studio/STUDIO_IA.md §2, prototype docs/studio/prototype/): the canvas workspace.
 * Every tool is a node; a wire is a real input; the selected node's inspector is the existing composer.
 *
 * The server reads exactly what /create reads for its composer — the models on sale for this workspace
 * (the operator's previews only in the operator's own organization), the plans a refusal may offer, the
 * models switched off, the channel's DNA and default look — and nothing else. Nothing is priced or spent
 * here: a price exists only once the composer asks the quote route for one.
 *
 * `?shelf=videos` and `?shelf=projects` are the list views /videos and /editor redirect to; they keep
 * their pages' reads, RLS and states (VideosShelf, ProjectsShelf).
 */
export default async function StudioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  if (sp.shelf !== undefined) return await ShelfView({ shelf: shelfFromQuery(sp.shelf) });
  if (!isSupabaseConfigured) return <NotConfigured />;
  if (sp.view === "live") {
    // The live view of one plan (S5's handoff opens it): a project (?film=) or a channel video run (?run=, a render_jobs id). It reads in
    // the browser through the read-only live routes; the server only says whether projects are open for this viewer.
    const film = parseFilmId(sp.film);
    // The section is open by the open workspace's switch. A named project's own workspace is checked by the live routes it reads
    // (filmGateFor: a 404, which the view shows as its "not found, pick another" state). Asking it here instead would turn a stale
    // film id (kept in this browser from another workspace) into "projects are switched off for this workspace", which is false.
    const filmStudio = await filmStudioOpen();
    const run = typeof sp.run === "string" && /^[1-9][0-9]{0,14}$/.test(sp.run) ? sp.run : null;
    // The Actions backend gives no run id: its run is the channel's events since the dispatch (/api/agent/run's dispatched_at).
    // channels.channel_id is a slug (0001), not a uuid.
    const channel = typeof sp.channel === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(sp.channel) ? sp.channel : null;
    const since = typeof sp.since === "string" && Number.isFinite(Date.parse(sp.since)) ? sp.since : null;
    const target = film
      ? { kind: "film" as const, id: film }
      : run
        ? { kind: "run" as const, id: run }
        : channel && since
          ? { kind: "window" as const, channel, since, hold: typeof sp.hold === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/.test(sp.hold) ? sp.hold : null }
          : null;
    // ?brain=<conversation> with no plan named: the conversation's brief as a draft, followed live once it is handed off.
    const brain = !target && typeof sp.brain === "string" && /^[0-9a-f-]{36}$/i.test(sp.brain) ? sp.brain : null;
    return <LiveView filmStudio={filmStudio} target={target} brain={brain} />;
  }
  if (sp.view === "timeline") {
    // The Timeline reads one project through /api/films (RLS, film_json) in the browser; the server only says whether the section is
    // open for this viewer, so a switched-off workspace sees "not open yet" and no project is read at all.
    const timelineFilm = parseFilmId(sp.film) ?? null;
    // As for the live view: the open workspace decides the section; the project's own workspace is /api/films/[id]'s (filmGateFor), whose
    // 404 is the Timeline's "not found" state with a way on. The Canvas/Timeline links carry a film id from localStorage, which is per
    // browser, not per workspace.
    const filmStudio = await filmStudioOpen();
    return <StudioTimeline filmStudio={filmStudio} filmId={timelineFilm} />;
  }

  const { selection, channels } = await getChannelContext();
  const scopedChannel = isScoped(selection) ? channels.find((c) => c.channel_id === selection) : undefined;
  const org = await getOrgContext();
  const orgId = org.supported && org.current ? org.current.id : null;
  if (ideaNeedsCreate(sp, !!orgId && aiChatOpenFor(orgId, aiChatEnv()))) redirect((await getChannelPath())("/create?idea=1"));
  const [models, plans, switchedOff] = orgId
    ? await Promise.all([loadStudioModels(orgId), loadUpsellCatalog(orgId), loadSwitchedOffModels()])
    : [[], null, [] as string[]];
  // The operator's hidden preview models are drawn only in the Owner account: the owner's User account sees what a customer sees.
  const asOperator = await viewingAsOperator();
  const previews = asOperator && isOperatorOrg(orgId) && orgId ? await loadOperatorPreviewModels(orgId) : [];
  const dna = await channelDnaForCreate(scopedChannel);
  const [user, slug, filmOpen] = await Promise.all([getUser(), getChannelSlug(), filmStudioOpen()]);
  // The admins-only beta is drawn only in the Owner account, like its nav entry; the Timeline's own link stays on the real role.
  // Under `on`, filmOpen already is the open workspace's own switch (filmStudioOpen reads it), so it is the workspace answer too.
  const filmStudio = filmOpen && filmStudioListed(filmStudioMode(), asOperator, filmOpen);

  const panelModels = withPreviews(models, previews);
  const canvas = (
    <StudioCanvas
      data={{
        orgId,
        models: panelModels,
        // Each effect's model is picked here, from the same offered list, and its composer prefill built here: the canvas is
        // handed the result, never the effects' model order (lib/effects/catalog.ts canvasEffects).
        effects: canvasEffects(panelModels),
        unavailable: switchedOff,
        plans,
        dna: dna.studio,
        defaultStyleKitId: startStyleKitId(null, scopedChannel?.default_style_kit_id),
      }}
      userId={user?.id ?? "anon"}
      channel={slug}
      filmStudio={filmStudio}
    />
  );
  // Nightshift AI (0199, docs/studio/NIGHTSHIFT_AI.md): docked on the left of the canvas, only where NIGHTSHIFT_AI_CHAT opens it.
  if (!orgId || !aiChatOpenFor(orgId, aiChatEnv())) return canvas;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const brain = one(sp.brain);
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
      <NightshiftAiPanel
        channelId={scopedChannel?.channel_id ?? null}
        channelSlug={slug}
        // "Salom, {name}", as the owner's chat greets: the auth profile's first name, never an address or a guess.
        greetingName={firstNameOf(user?.user_metadata)}
        initialSession={one(sp.ai) === "new" ? null : brain && /^[0-9a-f-]{36}$/i.test(brain) ? brain : null}
        // The landing page's idea (S4): ?ai=new&idea=1 opens a new conversation with it typed in, never sent.
        fresh={one(sp.ai) === "new"}
        takeIdea={one(sp.ai) === "new" && one(sp.idea) === "1"}
        initialPrompt={(one(sp.prompt) ?? "").slice(0, 2000) || null}
      />
      <div className="min-w-0">{canvas}</div>
    </div>
  );
}

/** The list views behind the canvas: Videos (where /videos redirects) and the editor's projects (where /editor redirects). */
async function ShelfView({ shelf }: { shelf: StudioShelf }) {
  const { t } = await getDictionary();
  const path = await getChannelPath();
  const name: Record<StudioShelf, string> = { projects: t.studioCanvas.viewEditor, videos: t.studioHub.shelfVideos };
  return (
    <div className="rhythm ns-open studio-shelf-view" data-studio-home="">
      <Link href={path("/studio")} className="studio-back-link" data-testid="back-to-canvas">
        <ArrowLeft aria-hidden className="size-4" /> {t.studioCanvas.viewCanvas}
      </Link>
      <PageHeader
        icon="studio"
        title={t.studioHub.title}
        subtitle={t.studioHub.subtitle}
        actions={
          <Link href={path("/studio/look")} className="studio-look-chip" data-testid="channel-look-chip">
            <Palette aria-hidden className="size-4" strokeWidth={1.9} />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="font-semibold">{t.studioHub.channelLook}</span>
              <span className="studio-look-chip-sub">{t.studioHub.channelLookHint}</span>
            </span>
          </Link>
        }
      />
      <section aria-label={t.studioHub.shelfLabel} className="flex flex-col gap-4">
        <nav aria-label={t.studioHub.shelfLabel} className="ns-tabs overflow-x-auto">
          <ul className="ns-tabs-track flex w-max gap-1">
            {STUDIO_SHELVES.map((s) => (
              <li key={s}>
                <Link href={path(`/studio?shelf=${s}`)} aria-current={shelf === s ? "page" : undefined} className="ns-tabs-link" data-testid={`studio-shelf-${s}`} scroll={false}>
                  {name[s]}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {shelf === "videos" ? <VideosShelf /> : <ProjectsShelf />}
      </section>
    </div>
  );
}
