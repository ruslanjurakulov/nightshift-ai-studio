import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Note } from "@/components/g3/Section";
import { EditorHome } from "@/components/editor/EditorHome";
import { getOrgContext } from "@/lib/orgs-server";
import { getDictionary } from "@/lib/i18n/server";
import { loadEditorProjects, loadEditorVideos } from "@/lib/server/editor";
import { FilmProjectsShelf } from "@/components/studio-hub/FilmProjectsShelf";

/**
 * Nightshift Studio's Projects shelf (/{channel}/studio?shelf=projects): the work in progress.
 *
 * - The scene-to-video projects (0166), only while NIGHTSHIFT_FILM_STUDIO opens them for this viewer
 *   (FilmProjectsShelf checks it first and renders nothing otherwise). /create/projects redirects here.
 * - The editor's projects (migration 0054), read as the signed-in user, exactly as /editor read them —
 *   RLS shows the open organization's projects and nothing else; editing and exporting are free, and an
 *   export ends in the library and is never published. /editor redirects here (lib/studioRoutes.ts).
 *
 * Every state the editor page had is kept: no organizations migration, no organization, the editor
 * migration missing, and a failed read each say so, never an empty list that reads as "none yet".
 */
export async function ProjectsShelf() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  return (
    <div className="rhythm" data-studio-shelf="projects">
      <FilmProjectsShelf />
      <EditorProjects />
    </div>
  );
}

async function EditorProjects() {
  const { t } = await getDictionary();
  const org = await getOrgContext();
  if (!org.supported) return <Note>{t.org.notMigrated}</Note>;
  if (!org.current) return <Note>{t.editor.noOrg}</Note>;

  const [projects, videos] = await Promise.all([loadEditorProjects(org.current.id), loadEditorVideos(org.current.id)]);
  if (projects.state === "not_available") return <Note>{t.editor.notEnabled}</Note>;
  if (projects.state !== "ok") return <Note>{t.editor.readFailed}</Note>;

  return (
    <section aria-labelledby="studio-editor-projects" className="rhythm" data-studio-shelf="edit">
      <div className="flex flex-col gap-1">
        <h2 id="studio-editor-projects" className="m-0 text-base font-semibold text-[var(--color-fg)]">
          {t.studioHub.editorProjects}
        </h2>
        <p className="m-0 max-w-[70ch] text-sm text-[var(--color-muted)]">{t.studioHub.projectsLead}</p>
      </div>
      <EditorHome orgId={org.current.id} projects={projects.value} videos={videos.state === "ok" ? videos.value : null} />
    </section>
  );
}
