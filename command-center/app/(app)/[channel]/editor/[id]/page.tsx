import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { Note } from "@/components/g3/Section";
import { TimelineEditor } from "@/components/editor/TimelineEditor";
import { getOrgContext } from "@/lib/orgs-server";
import { getUser } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { loadSellableModels } from "@/lib/creative/registry";
import { loadAiToolAvailability } from "@/lib/server/ai-tools";
import { parseIdParam } from "@/lib/creative/improve";
import {
  loadEditorImages,
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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `add`: a finished AI result to offer ("Add to project"); `focus=captions`: open on the Captions panel. */
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { id } = await params;
  const { t } = await getDictionary();
  const org = await getOrgContext();
  const note = (text: string) => (
    <div className="rhythm ns-open">
      <PageHeader
        icon="editor"
        title={t.editor.title}
        subtitle={t.editor.subtitle}
      />
      <Note>{text}</Note>
    </div>
  );
  if (!org.supported) return note(t.org.notMigrated);
  if (!org.current) return note(t.editor.noOrg);

  const project = await loadEditorProject(id);
  if (project.state === "not_found") notFound();
  if (project.state === "not_available") return note(t.editor.notEnabled);
  if (project.state !== "ok") return note(t.editor.readFailed);
  const [videos, sounds, images, sellable, aiTools] = await Promise.all([
    loadEditorVideos(project.value.orgId),
    loadEditorSounds(project.value.orgId),
    loadEditorImages(project.value.orgId),
    // Auto-captions (0072): only a model the database would sell (verified,
    // priced, no open terms gate) is offered; none = the panel says so.
    loadSellableModels("captions"),
    // "Improve with AI" on a clip or picture: which tools are sold here (the Studio prices them).
    loadAiToolAvailability(),
  ]);
  const q = (await searchParams) ?? {};
  const focus = Array.isArray(q.focus) ? q.focus[0] : q.focus;
  const captionModels = sellable.models.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    languages: m.spec.languages,
  }));
  const p = project.value;
  // Keys the local draft: a draft is only ever offered to the member who wrote it.
  const user = await getUser();

  return (
    <div className="rhythm">
      <PageHeader icon="editor" title={p.title} subtitle={t.editor.subtitle} compactPhone />
      <TimelineEditor
        projectId={p.id}
        title={p.title}
        rev={p.rev}
        doc={p.doc}
        exports={p.exports}
        assets={p.assets}
        videos={videos.state === "ok" ? videos.value : []}
        soundFiles={sounds.state === "ok" ? sounds.value : []}
        imageFiles={images.state === "ok" ? images.value : []}
        orgId={p.orgId}
        captionModels={captionModels}
        userId={user?.id ?? ""}
        aiTools={aiTools}
        offerAssetId={parseIdParam(q.add)}
        focusPanel={focus === "captions" ? "captions" : null}
      />
    </div>
  );
}
