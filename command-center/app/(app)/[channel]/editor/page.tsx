import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { EditorHome } from "@/components/editor/EditorHome";
import { getOrgContext } from "@/lib/orgs-server";
import { getDictionary } from "@/lib/i18n/server";
import { loadEditorProjects, loadEditorVideos } from "@/lib/server/editor";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The video editor's projects (migration 0054), read as the signed-in user:
 * RLS shows the open organization's projects and videos and nothing else.
 * Editing and exporting are free; an export ends in the library and is never
 * published from here. Without the migration the page says so.
 */
export default async function EditorPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const org = await getOrgContext();
  const header = (
    <PageHeader
      icon="editor"
      title={t.editor.title}
      subtitle={t.editor.subtitle}
    />
  );
  const note = (text: string) => (
    <div className="rhythm">
      {header}
      <div className="panel p-5 sm:p-6 text-sm text-[var(--color-muted)]">
        {text}
      </div>
    </div>
  );
  if (!org.supported) return note(t.org.notMigrated);
  if (!org.current) return note(t.editor.noOrg);

  const [projects, videos] = await Promise.all([
    loadEditorProjects(org.current.id),
    loadEditorVideos(org.current.id),
  ]);
  if (projects.state === "not_available") return note(t.editor.notEnabled);
  if (projects.state !== "ok") return note(t.editor.readFailed);

  return (
    <div className="rhythm">
      {header}
      <EditorHome
        orgId={org.current.id}
        projects={projects.value}
        videos={videos.state === "ok" ? videos.value : null}
      />
    </div>
  );
}
