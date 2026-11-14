import Link from "next/link";
import { Palette } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { StudioTiles } from "@/components/studio-hub/StudioTiles";
import { VideosShelf } from "@/components/studio-hub/VideosShelf";
import { ProjectsShelf } from "@/components/studio-hub/ProjectsShelf";
import { getDictionary } from "@/lib/i18n/server";
import { getChannelPath } from "@/lib/channels-path-server";
import { STUDIO_SHELVES, shelfFromQuery, type StudioShelf } from "@/lib/studioRoutes";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Nightshift Studio's home (docs/studio/STUDIO_IA.md §4–5, build step 1: "IA shell, no new
 * behaviour"). The owner's complaint was that the creative tools were eight sections that felt
 * unrelated; this is the one place they now live.
 *
 * - The header's Channel look chip opens Brand look (/studio/look): /studio used to BE Brand look,
 *   so an old bookmark lands here, one click away (§9.1, adopted).
 * - The tiles open every tool's page as it is today (lib/studioRoutes.ts maps the old URLs).
 * - The shelf: Projects (the editor's projects, which /editor now redirects to) and Videos (what
 *   /videos listed, which now redirects to `?shelf=videos`).
 *
 * The page reads; it never writes, prices or starts anything. Each shelf keeps the reads, the RLS and
 * the loading, empty and error states its old page had. The canvas (`/studio/{kind}/{id}`) is the
 * next build step and is not here.
 */
export default async function StudioHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const shelf = shelfFromQuery(sp.shelf);
  const { t } = await getDictionary();
  const path = await getChannelPath();
  const shelfName: Record<StudioShelf, string> = { projects: t.studioHub.shelfProjects, videos: t.studioHub.shelfVideos };

  return (
    <div className="rhythm ns-open stagger-enter" data-studio-home="">
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

      <StudioTiles />

      <section aria-label={t.studioHub.shelfLabel} className="flex flex-col gap-4">
        {/* Two links, not a client tab widget: each shelf is its own URL (shareable, and a reload keeps it). */}
        <nav aria-label={t.studioHub.shelfLabel} className="ns-tabs overflow-x-auto">
          <ul className="ns-tabs-track flex w-max gap-1">
            {STUDIO_SHELVES.map((s) => (
              <li key={s}>
                <Link
                  href={path(s === "projects" ? "/studio" : `/studio?shelf=${s}`)}
                  aria-current={shelf === s ? "page" : undefined}
                  className="ns-tabs-link"
                  data-testid={`studio-shelf-${s}`}
                  scroll={false}
                >
                  {shelfName[s]}
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
