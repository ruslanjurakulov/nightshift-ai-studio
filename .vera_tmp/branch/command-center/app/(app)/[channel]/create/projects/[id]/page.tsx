import Link from "next/link";
import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { FilmCanvas } from "@/components/films/FilmCanvas";
import type { LibraryPicture } from "@/components/films/SceneDetail";
import type { LibraryCharacter } from "@/components/films/ProjectPanel";
import "@/components/films/films.css";
import { createClient } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { getOrgContext } from "@/lib/orgs-server";
import { getChannelPath } from "@/lib/channels-path-server";
import { STUDIO_PROJECTS } from "@/lib/navigation";
import { filmStudioStrings } from "@/lib/i18n/film-studio";
import { filmStudioOpenFor, readFilm } from "@/lib/server/films";
import { MEDIA_ASSET_COLUMNS, coerceAssets } from "@/lib/media";
import { mediaDir, mediaUrlSecret, withUrls } from "@/lib/server/media";
import { CHARACTER_COLUMNS } from "@/lib/style-kits";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const EDIT_ROLES = ["owner", "admin", "editor"];
/** The newest library pictures offered as frames and references; a picture outside them stays chosen and is never called missing. */
const PICTURE_LIMIT = 60;

type Client = NonNullable<Awaited<ReturnType<typeof createClient>>>;

/** The workspace's pictures and characters, read as the member (RLS). A failed read offers none rather than guessing. */
async function loadPickables(supabase: Client, orgId: string): Promise<{ pictures: LibraryPicture[]; characters: LibraryCharacter[] }> {
  try {
    const [pics, chars] = await Promise.all([
      supabase
        .from("media_assets")
        .select(MEDIA_ASSET_COLUMNS)
        .eq("org_id", orgId)
        .eq("kind", "image")
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(PICTURE_LIMIT),
      supabase.from("characters").select(CHARACTER_COLUMNS).eq("org_id", orgId).order("created_at", { ascending: false }).limit(100),
    ]);
    const secret = mediaUrlSecret();
    const served = Boolean(mediaDir());
    const pictures = pics.error
      ? []
      : coerceAssets(pics.data)
          .filter((a) => a.kind === "image")
          .map((a) => ({ id: a.id, name: a.name ?? null, thumbUrl: withUrls(a, secret, served).thumbUrl ?? null }));
    const characters = chars.error
      ? []
      : (Array.isArray(chars.data) ? chars.data : []).flatMap((r: Record<string, unknown>) =>
          typeof r.id === "string" && typeof r.name === "string" ? [{ id: r.id, name: r.name }] : [],
        );
    return { pictures, characters };
  } catch {
    return { pictures: [], characters: [] };
  }
}

/**
 * One project's canvas (Studio → Projects; NIGHTSHIFT_FILM_STUDIO, default off: a 404). The read model is 0166's film_json as the
 * member: another workspace's project reads exactly like a missing one, and either says so, never an empty canvas.
 */
export default async function StudioProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The project's own workspace, not only the open one (filmStudioOpenFor): a person in two workspaces can name the other's project.
  if (!(await filmStudioOpenFor(id))) notFound();
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { locale } = await getDictionary();
  const s = filmStudioStrings(locale);
  const path = await getChannelPath();
  const listHref = path(STUDIO_PROJECTS);
  const supabase = await createClient();
  if (!supabase) return <NotConfigured />;
  const [read, org] = await Promise.all([readFilm(supabase, id), getOrgContext()]);
  if (!read.ok) {
    const title = read.error === "not_found" ? s.canvas.notFoundTitle : read.error === "session_expired" ? s.canvas.sessionTitle : s.canvas.loadFailed;
    const body =
      read.error === "not_found"
        ? s.canvas.notFoundBody
        : read.error === "session_expired"
          ? s.errors.session_expired
          : read.error === "not_available"
            ? s.notAvailable
            : s.errors.failed;
    return (
      <div className="fs-root rhythm ns-open">
        <div className="fs-empty" role={read.error === "not_found" ? undefined : "alert"} data-testid={`fs-page-${read.error}`}>
          <h1 className="fs-h2">{title}</h1>
          <p className="m-0 text-base">{body}</p>
          <Link href={listHref} className="btn-quiet min-h-11 px-4 text-sm">
            {s.canvas.back}
          </Link>
        </div>
      </div>
    );
  }
  const film = read.view.film;
  // Presentation only: only an editor of the project's own workspace sees the fields enabled. The database checks again on every write.
  const canEdit = org.current?.id === film.orgId && EDIT_ROLES.includes(org.current.role);
  // Read for a viewer too: the references are named by them.
  const pick = await loadPickables(supabase, film.orgId);
  return <FilmCanvas initial={read.view} canEdit={canEdit} pictures={pick.pictures} characters={pick.characters} listHref={listHref} />;
}
