import { Note } from "@/components/g3/Section";
import { FilmList, type FilmListInitial } from "@/components/films/FilmList";
import { FilmShelfReadNotice } from "./FilmShelfReadNotice";
import "@/components/films/films.css";
import { createClient } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { getOrgContext } from "@/lib/orgs-server";
import { getChannelContext } from "@/lib/channels-server";
import { isScoped } from "@/lib/channels";
import { filmStudioStrings } from "@/lib/i18n/film-studio";
import { filmStudioOpen, listFilms } from "@/lib/server/films";

const EDIT_ROLES = ["owner", "admin", "editor"];

/**
 * The scene-to-video projects (migration 0166, NIGHTSHIFT_FILM_STUDIO) on the Studio home's Projects
 * shelf: what /create/projects listed, which now redirects here. Exactly that page's reads and rules:
 * the switch is checked first and, off (or `admins` for anyone but a platform admin), this renders
 * nothing and reads nothing; the list is read as the member through RLS; "New project" creates a draft
 * and nothing else; a viewer gets the list without the button (the database checks the role again).
 */
export async function FilmProjectsShelf() {
  if (!(await filmStudioOpen())) return null;
  const { t, locale } = await getDictionary();
  const s = filmStudioStrings(locale);
  const heading = (
    <h2 className="m-0 text-base font-semibold text-[var(--color-fg)]" id="studio-film-projects">
      {s.tagline}
    </h2>
  );
  const org = await getOrgContext();
  if (!org.supported) return <section aria-labelledby="studio-film-projects" className="rhythm">{heading}<Note>{t.org.notMigrated}</Note></section>;
  if (!org.current) return <section aria-labelledby="studio-film-projects" className="rhythm">{heading}<Note>{s.noOrg}</Note></section>;
  const supabase = await createClient();
  if (!supabase) return (
    <section aria-labelledby="studio-film-projects" className="rhythm" data-studio-shelf="films">
      {heading}
      <FilmShelfReadNotice message={s.list.loadFailed} retryLabel={s.retry} />
    </section>
  );
  const [read, ctx] = await Promise.all([listFilms(supabase, org.current.id, false), getChannelContext()]);
  const initial: FilmListInitial = read.ok ? { state: "ok", films: read.films } : read.error === "not_available" ? { state: "not_available" } : { state: "failed" };
  // A project made while one channel is in view is made for that channel (the database checks it is this workspace's).
  const scoped = isScoped(ctx.selection) ? ctx.channels.find((c) => c.channel_id === ctx.selection) : undefined;
  const channel = scoped && scoped.org_id === org.current.id ? { id: scoped.channel_id, name: scoped.name || scoped.channel_id } : null;
  const canEdit = EDIT_ROLES.includes(org.current.role);
  return (
    <section aria-labelledby="studio-film-projects" className="rhythm" data-studio-shelf="films">
      {heading}
      <FilmList initial={initial} canEdit={canEdit} channel={channel} studioName={t.nav.hub} />
    </section>
  );
}
