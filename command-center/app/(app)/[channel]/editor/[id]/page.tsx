import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import { getOrgContext } from "@/lib/orgs-server";
import { getDictionary } from "@/lib/i18n/server";
import {
  loadEditorProject,
  loadEditorSounds,
  loadEditorVideos,
} from "@/lib/server/editor";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * One editor project. Another organization's project and a made-up id are the
 * same 404: RLS returns no row for either.
 */
export default async function EditorProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { id } = await params;
  const { t } = await getDictionary();
  const org = await getOrgContext();
  const note = (text: string) => (
    <div className="rhythm">
      <PageHeader
        icon="editor"
        title={t.editor.title}
        subtitle={t.editor.subtitle}
      />
      <div className="panel p-4 text-[13px] text-[var(--color-muted)]">
        {text}
      </div>
    </div>
  );
  if (!org.supported) return note(t.org.notMigrated);
  if (!org.current) return note(t.editor.noOrg);

  const project = await loadEditorProject(id);
  if (project.state === "not_found") notFound();
  if (project.state === "not_available") return note(t.editor.notEnabled);
  if (project.state !== "ok") return note(t.editor.readFailed);
  const [videos, sounds] = await Promise.all([
    loadEditorVideos(project.value.orgId),
    loadEditorSounds(project.value.orgId),
  ]);
  const p = project.value;

  return (
    <div className="rhythm">
      <PageHeader icon="editor" title={p.title} subtitle={t.editor.subtitle} />
      <TimelineEditor
        projectId={p.id}
        title={p.title}
        rev={p.rev}
        doc={p.doc}
        exports={p.exports}
        assets={p.assets}
        videos={videos.state === "ok" ? videos.value : []}
        soundFiles={sounds.state === "ok" ? sounds.value : []}
      />
    </div>
  );
}
