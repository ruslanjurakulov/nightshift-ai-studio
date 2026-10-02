import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { RunView } from "@/components/workflows/RunView";
import { getOrgContext } from "@/lib/orgs-server";
import { getDictionary } from "@/lib/i18n/server";
import { loadRun } from "@/lib/server/workflows";
import { canCarryRun } from "@/lib/workflows";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * One run (migration 0073): every step's status and price. While it is
 * running, a member who may run workflows has this page carry it on — each
 * step is created and held only when the one before it has completed.
 */
export default async function WorkflowRunPage({ params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const { id } = await params;
  const org = await getOrgContext();
  const header = <PageHeader icon="workflows" title={t.workflows.runPage.title} subtitle={t.workflows.moneyNote} />;
  const note = (text: string) => (
    <div className="rhythm">
      {header}
      <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{text}</div>
    </div>
  );
  if (!org.supported) return note(t.org.notMigrated);
  if (!org.current) return note(t.workflows.noOrg);
  const read = await loadRun(id);
  if (read.state === "not_available") return note(t.workflows.notEnabled);
  if (read.state === "not_found") return note(t.workflows.runNotFound);
  if (read.state !== "ok") return note(t.workflows.readFailed);

  return (
    <div className="rhythm">
      {header}
      {/* The caller's role in the RUN's organization (a run of another org they belong to stays theirs to carry on or not). */}
      <RunView initial={read.value} canAct={canCarryRun(org.orgs, read.value.org_id)} toolLabels={t.workflows.tools} />
    </div>
  );
}
