import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { WorkflowsHome } from "@/components/workflows/WorkflowsHome";
import { getOrgContext } from "@/lib/orgs-server";
import { getDictionary } from "@/lib/i18n/server";
import { resolveCurrentOrgRole } from "@/lib/auth/org-roles";
import { atLeast } from "@/lib/auth/roles";
import { loadStudioModels } from "@/lib/server/creative";
import { loadRuns, loadWorkflows } from "@/lib/server/workflows";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The organization's saved workflows (migration 0073), read as the signed-in
 * user: RLS shows this organization's and nothing else. Saving costs nothing;
 * a run starts only from a workflow's own page, after its one total price is
 * shown and confirmed. Without the migration the page says so.
 */
export default async function WorkflowsPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const org = await getOrgContext();
  const header = <PageHeader icon="workflows" title={t.workflows.title} subtitle={t.workflows.subtitle} />;
  const note = (text: string) => (
    <div className="rhythm">
      {header}
      <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{text}</div>
    </div>
  );
  if (!org.supported) return note(t.org.notMigrated);
  if (!org.current) return note(t.workflows.noOrg);

  const [list, runs, models, role] = await Promise.all([
    loadWorkflows(org.current.id),
    loadRuns(org.current.id),
    loadStudioModels(),
    resolveCurrentOrgRole(),
  ]);
  if (list.state === "not_available") return note(t.workflows.notEnabled);
  if (list.state !== "ok") return note(t.workflows.readFailed);

  return (
    <div className="rhythm">
      {header}
      <WorkflowsHome
        orgId={org.current.id}
        models={models}
        workflows={list.value}
        runs={runs.state === "ok" ? runs.value : []}
        canEdit={atLeast(role, "editor")}
      />
    </div>
  );
}
