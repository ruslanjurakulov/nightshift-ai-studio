import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { MediaLibrary } from "@/components/media/MediaLibrary";
import { getOrgContext } from "@/lib/orgs-server";
import { getDictionary } from "@/lib/i18n/server";
import { fmt } from "@/lib/i18n";
import { loadMediaLibrary } from "@/lib/server/media";
import { atLeast } from "@/lib/auth/roles-shared";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The organization's media library (migration 0038): what it has uploaded or
 * Nightshift has made for it, uploads on their way, and its storage.
 *
 * Everything is read as the signed-in user, so RLS shows the rows of the open
 * organization and nothing else. Uploading asks the database for a ticket
 * (request_upload: membership, type, size, quota) and streams the file to the
 * server's staging volume; the media worker checks the content before an
 * asset appears here. On a host without the media volumes, without the
 * migration, or without a signing key, the page says exactly that.
 *
 * Folder controls (new, rename, delete, move, upload into a folder) are shown
 * to editors and up: the role is the database's own answer for this
 * organization (my_organizations -> org_role). Hiding them is for the reader;
 * the database refuses a viewer either way (0049, 0051).
 */
export default async function LibraryPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const org = await getOrgContext();
  const header = (name: string) => (
    <PageHeader icon="library" title={t.media.title} subtitle={fmt(t.media.subtitle, { org: name })} />
  );
  const note = (text: string) => (
    <div className="rhythm">
      {header("—")}
      <div className="panel p-5 sm:p-6 text-sm text-[var(--color-muted)]">{text}</div>
    </div>
  );

  if (!org.supported) return note(t.org.notMigrated);
  if (!org.current) return note(t.media.noOrg);

  const lib = await loadMediaLibrary(org.current.id);
  if (!lib.available) return note(t.media.notEnabled);

  return (
    <div className="rhythm">
      {header(org.current.name)}
      <MediaLibrary orgId={org.current.id} initial={lib} canEditFolders={atLeast(org.current.role, "editor")} />
    </div>
  );
}
