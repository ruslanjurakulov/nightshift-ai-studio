import Link from "next/link";
import { ArrowLeft, Palette } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { NotConfigured } from "@/components/NotConfigured";
import { StudioCanvas } from "@/components/studio-canvas/StudioCanvas";
import { StudioTimeline } from "@/components/studio-timeline/StudioTimeline";
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
import { isOperator } from "@/lib/auth/org-roles";
import { isOperatorOrg } from "@/lib/channel-tokens";
import { loadOperatorPreviewModels, loadStudioModels, loadSwitchedOffModels } from "@/lib/server/creative";
import { loadUpsellCatalog } from "@/lib/server/upsell";
import { withPreviews } from "@/lib/creative/studio";
import { channelDnaForCreate } from "@/lib/server/channel-dna";
import { startStyleKitId } from "@/lib/styles/add";
import { filmStudioOpen } from "@/lib/server/films";
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
  if (sp.view === "timeline") {
    // The Timeline reads one project through /api/films (RLS, film_json) in the browser; the server only says whether the section is
    // open for this viewer, so a switched-off workspace sees "not open yet" and no project is read at all.
    const filmStudio = await filmStudioOpen();
    return <StudioTimeline filmStudio={filmStudio} filmId={parseFilmId(sp.film) ?? null} />;
  }

  const { selection, channels } = await getChannelContext();
  const scopedChannel = isScoped(selection) ? channels.find((c) => c.channel_id === selection) : undefined;
  const org = await getOrgContext();
  const orgId = org.supported && org.current ? org.current.id : null;
  const [models, plans, switchedOff] = orgId
    ? await Promise.all([loadStudioModels(orgId), loadUpsellCatalog(orgId), loadSwitchedOffModels()])
    : [[], null, [] as string[]];
  const operator = await isOperator();
  const previews = operator && isOperatorOrg(orgId) && orgId ? await loadOperatorPreviewModels(orgId) : [];
  const dna = await channelDnaForCreate(scopedChannel);
  const [user, slug, filmStudio] = await Promise.all([getUser(), getChannelSlug(), filmStudioOpen()]);

  return (
    <StudioCanvas
      data={{
        orgId,
        models: withPreviews(models, previews),
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
