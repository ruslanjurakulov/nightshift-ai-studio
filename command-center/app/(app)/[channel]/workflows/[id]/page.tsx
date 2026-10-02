import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { PageHeader } from "@/components/PageHeader";
import { WorkflowRunPanel } from "@/components/workflows/WorkflowRunPanel";
import { getOrgContext } from "@/lib/orgs-server";
import { getDictionary } from "@/lib/i18n/server";
import { resolveCurrentOrgRole } from "@/lib/auth/org-roles";
import { atLeast } from "@/lib/auth/roles";
import { loadWorkflow } from "@/lib/server/workflows";
import { getChannelPath } from "@/lib/channels-path-server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * One workflow: its inputs, ONE total price and Run now (migration 0073).
 * Read as the signed-in user; another organization's workflow reads exactly
 * like one that does not exist.
 */
export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const { id } = await params;
  const org = await getOrgContext();
  const back = (await getChannelPath())("/workflows");
  const note = (text: string, title = t.workflows.title) => (
    <div className="rhythm">
      <PageHeader icon="workflows" title={title} subtitle={t.workflows.subtitle} />
      <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{text}</div>
    </div>
  );
  if (!org.supported) return note(t.org.notMigrated);
  if (!org.current) return note(t.workflows.noOrg);
  const [read, role] = await Promise.all([loadWorkflow(id), resolveCurrentOrgRole()]);
  if (read.state === "not_available") return note(t.workflows.notEnabled);
  if (read.state === "not_found") return note(t.workflows.notFound);
  if (read.state !== "ok") return note(t.workflows.readFailed);
  const wf = read.value;

  return (
    <div className="rhythm">
      <PageHeader
        icon="workflows"
        title={wf.name}
        subtitle={t.workflows.moneyNote}
        actions={
          <Link href={back} className="btn-sky ghost pill px-4 py-2 text-[13px]">
            {t.workflows.back}
          </Link>
        }
      />
      <WorkflowRunPanel workflow={wf} orgId={org.current.id} canRun={atLeast(role, "editor")} toolLabels={t.workflows.tools} />
    </div>
  );
}
