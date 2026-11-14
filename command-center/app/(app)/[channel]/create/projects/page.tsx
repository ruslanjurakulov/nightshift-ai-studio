import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { Note } from "@/components/g3/Section";
import { DeskBar } from "@/components/studio/Desks";
import { FilmList, type FilmListInitial } from "@/components/films/FilmList";
import "@/components/films/films.css";
import { createClient } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { getOrgContext } from "@/lib/orgs-server";
import { getChannelContext } from "@/lib/channels-server";
import { isScoped } from "@/lib/channels";
import { filmStudioStrings } from "@/lib/i18n/film-studio";
import { filmStudioOpen, listFilms } from "@/lib/server/films";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const EDIT_ROLES = ["owner", "admin", "editor"];

/**
 * Studio → Projects (NIGHTSHIFT_FILM_STUDIO, default off: this page is then a 404, exactly as if it did not exist, and no navigation
 * lists it; `admins` opens it to platform admins only). The open workspace's projects, read as the member through RLS, and "New
 * project", which creates a draft and nothing else (docs/FILM_STUDIO.md).
 */
export default async function StudioProjectsPage() {
  if (!(await filmStudioOpen())) notFound();
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t, locale } = await getDictionary();
  const s = filmStudioStrings(locale);
  const header = (
    <>
      <PageHeader icon="studio" title={s.section} subtitle={s.tagline} />
      <DeskBar current="projects" />
    </>
  );
  const org = await getOrgContext();
  if (!org.supported) return <div className="rhythm ns-open">{header}<Note>{t.org.notMigrated}</Note></div>;
  if (!org.current) return <div className="rhythm ns-open">{header}<Note>{s.noOrg}</Note></div>;
  const supabase = await createClient();
  if (!supabase) return <NotConfigured />;
  const [read, ctx] = await Promise.all([listFilms(supabase, org.current.id, false), getChannelContext()]);
  const initial: FilmListInitial = read.ok ? { state: "ok", films: read.films } : read.error === "not_available" ? { state: "not_available" } : { state: "failed" };
  // A project made while one channel is in view is made for that channel (the database checks it is this workspace's).
  const scoped = isScoped(ctx.selection) ? ctx.channels.find((c) => c.channel_id === ctx.selection) : undefined;
  const channel = scoped && scoped.org_id === org.current.id ? { id: scoped.channel_id, name: scoped.name || scoped.channel_id } : null;
  // Presentation only: a viewer gets the list without the button. The database checks the role again on every write.
  const canEdit = EDIT_ROLES.includes(org.current.role);
  return (
    <div className="rhythm ns-open">
      {header}
      <FilmList initial={initial} canEdit={canEdit} channel={channel} studioName={t.nav.hub} />
    </div>
  );
}
