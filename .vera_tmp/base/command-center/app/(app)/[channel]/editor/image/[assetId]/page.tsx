import Link from "next/link";
import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { Note } from "@/components/g3/Section";
import { ImageEditor } from "@/components/imageEditor/ImageEditor";
import { getDictionary } from "@/lib/i18n/server";
import { fmt } from "@/lib/i18n";
import { getOrgContext } from "@/lib/orgs-server";
import { getChannelContext } from "@/lib/channels-server";
import { channelPath } from "@/lib/channels";
import { createClient, getUser } from "@/lib/supabase/server";
import { imageEditorEnabled } from "@/lib/imageEditor/flag";
import { MAX_EDIT_PIXELS } from "@/lib/imageEditor/state";
import { readEditableAsset } from "@/lib/server/image-editor";
import { parseMediaId } from "@/lib/media";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Image editor (NIGHTSHIFT_IMAGE_EDITOR, default off: this page is then a 404, exactly as if it did not exist). Crop, turn,
 * colours, text and shapes on one library picture, in the browser. Saving uploads a NEW library file through the existing
 * upload ticket; nothing is written here and nothing is priced. Another organization's picture and a made-up id are the
 * same 404: the picture is read under the member's own session and must belong to the open organization.
 */
export default async function ImageEditorPage({ params }: { params: Promise<{ assetId: string }> }) {
  if (!imageEditorEnabled()) notFound();
  const { assetId: raw } = await params;
  const assetId = parseMediaId(raw);
  if (!assetId) notFound();
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const { slug } = await getChannelContext();
  const e = t.imageEditor;
  const libraryHref = channelPath(slug, "/library");
  const header = <PageHeader icon="editor" title={e.title} subtitle={e.subtitle} />;
  const user = await getUser();
  const org = await getOrgContext();
  if (!user || !org.supported) return <div className="rhythm ns-open">{header}<Note>{t.org.notMigrated}</Note></div>;
  if (!org.current) return <div className="rhythm ns-open">{header}<Note>{e.orgRequired}</Note></div>;
  const supabase = await createClient();
  if (!supabase) return <NotConfigured />;
  const read = await readEditableAsset(supabase, org.current.id, assetId);
  if (!read.ok && read.error === "not_found") notFound();
  const problem = !read.ok
    ? read.error === "unsupported_type"
      ? e.unsupported
      : read.error === "source_too_large"
        ? fmt(e.tooLarge, { mp: read.megapixels, max: MAX_EDIT_PIXELS / 1_000_000 })
        : read.error === "no_size"
          ? e.noSize
          : e.imageFailed
    : null;
  return (
    <div className="rhythm ns-open stagger-enter">
      {header}
      {problem ? (
        <div className="flex flex-col gap-3" role="alert">
          <Note>{problem}</Note>
          <div><Link href={libraryHref} className="btn-quiet">{e.libraryLink}</Link></div>
        </div>
      ) : read.ok ? (
        <ImageEditor assetId={assetId} orgId={org.current.id} name={read.asset.name} libraryHref={libraryHref} />
      ) : null}
    </div>
  );
}
