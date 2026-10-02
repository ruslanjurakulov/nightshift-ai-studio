import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { getDictionary } from "@/lib/i18n/server";
import { getOrgContext } from "@/lib/orgs-server";
import { isMissingRelation, parseStyleId } from "@/lib/style-kits";
import { LIBRARY_ID_RE } from "@/lib/styles/library";
import { StyleLibrary, type AddState } from "@/components/styles/StyleLibrary";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The Style Library: built-in art directions to browse, and to add to the open
 * organization as style kits. Browsing needs neither a workspace nor the
 * database; only "added" state and the add itself do, and when they are not
 * there (no workspace, migration 0065 not applied, a failed read) the page says
 * so and keeps the browse working — never an empty "added" list that reads as
 * "you have none".
 */
export default async function StylesPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const org = await getOrgContext();

  let addState: AddState = "no-org";
  const added: Record<string, string> = {};
  if (org.current) {
    addState = "not-enabled";
    const supabase = await createClient();
    if (supabase) {
      // Read as the member (RLS). library_id exists only once 0065 is applied.
      const { data, error } = await supabase
        .from("style_kits")
        .select("id, library_id")
        .eq("org_id", org.current.id)
        .not("library_id", "is", null);
      if (error) {
        addState = isMissingRelation(error) ? "not-enabled" : "read-failed";
      } else {
        addState = "ready";
        for (const row of Array.isArray(data) ? (data as Array<{ id?: unknown; library_id?: unknown }>) : []) {
          const id = parseStyleId(row.id);
          if (id && typeof row.library_id === "string" && LIBRARY_ID_RE.test(row.library_id)) added[row.library_id] = id;
        }
      }
    }
  }

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="styles" title={t.styleLibrary.title} subtitle={t.styleLibrary.subtitle} />
      <StyleLibrary orgId={org.current?.id ?? null} addState={addState} initialAdded={added} />
    </div>
  );
}
