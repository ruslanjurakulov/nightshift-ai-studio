"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Play, Plus, Trash2, Waypoints } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { formatCredits } from "@/lib/credits";
import type { StudioModel } from "@/lib/creative/studio";
import type { Workflow } from "@/lib/workflows";
import { WorkflowBuilder } from "./WorkflowBuilder";
import { removeWorkflow } from "./workflowsApi";
import { workflowErrorMessage } from "@/lib/workflows";

export interface RunRow {
  id: string;
  workflow_name: string;
  status: string;
  max_credits: number;
  charged_credits: number;
  created_at: string | null;
}

/**
 * The organization's saved workflows, a place to make or change one, and its
 * recent runs. Saving and removing cost nothing and run nothing; a run starts
 * only from a workflow's own page, after its total is shown and confirmed.
 */
export function WorkflowsHome({
  orgId,
  models,
  workflows,
  runs,
  canEdit,
}: {
  orgId: string;
  models: StudioModel[];
  workflows: readonly Workflow[];
  runs: readonly RunRow[];
  canEdit: boolean;
}) {
  const { t, locale } = useI18n();
  const w = t.workflows;
  const path = useChannelPath();
  const router = useRouter();
  const id = useId();
  const [editing, setEditing] = useState<Workflow | "new" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const when = (iso: string | null) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  };

  async function onRemove(wf: Workflow) {
    setBusy(wf.id);
    setError(null);
    const out = await removeWorkflow(wf.id);
    setBusy(null);
    setConfirmRemove(null);
    if (!out.ok) {
      setError(workflowErrorMessage(t, out.error));
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-[13px] text-[var(--color-muted)]">
        {w.moneyNote} {w.publishNote}
      </p>
      {!canEdit ? <p className="m-0 text-[13px] text-[var(--color-muted)]">{w.readOnly}</p> : null}

      {editing ? (
        <WorkflowBuilder
          key={editing === "new" ? "new" : editing.id}
          orgId={orgId}
          models={models}
          initial={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : canEdit ? (
        <div>
          <button type="button" onClick={() => setEditing("new")} className="btn-sky is-solid pill inline-flex items-center gap-2 px-4 py-2 text-[13px]">
            <Plus className="size-4" aria-hidden />
            {w.newWorkflow}
          </button>
        </div>
      ) : null}

      <section aria-labelledby={`${id}-list`} className="flex flex-col gap-2">
        <h2 id={`${id}-list`} className="m-0 text-[15px] font-semibold">
          {w.listTitle}
        </h2>
        {error ? (
          <p role="alert" className="m-0 text-[13px] text-[var(--color-fail)]">
            {error}
          </p>
        ) : null}
        {workflows.length === 0 ? (
          <div className="panel flex flex-col items-center gap-3 px-6 py-10 text-center">
            <Waypoints className="size-6 text-[var(--color-primary)]" aria-hidden />
            <p className="m-0 max-w-[48ch] text-[13px] text-[var(--color-muted)]">{w.empty}</p>
          </div>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {workflows.map((wf) => (
              <li key={wf.id} className="panel flex flex-col gap-2 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-[14px] font-semibold">{wf.name}</span>
                    <span className="text-[12px] text-[var(--color-muted)]">
                      {fmt(w.stepsCount, { n: wf.steps.length })} · {fmt(w.updated, { when: when(wf.updated_at) })}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link href={path(`/workflows/${wf.id}`)} className="btn-sky is-solid pill inline-flex items-center gap-2 px-4 py-2 text-[13px]">
                      <Play className="size-4" aria-hidden />
                      {w.open}
                    </Link>
                    {canEdit ? (
                      <>
                        <button type="button" onClick={() => setEditing(wf)} className="btn-sky ghost pill inline-flex items-center gap-2 px-3 py-2 text-[13px]">
                          <Pencil className="size-4" aria-hidden />
                          {w.edit}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRemove(confirmRemove === wf.id ? null : wf.id)}
                          className="btn-sky is-quiet pill inline-flex items-center gap-2 px-3 py-2 text-[13px]"
                        >
                          <Trash2 className="size-4" aria-hidden />
                          {w.remove}
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
                <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0 text-[12px] text-[var(--color-muted)]">
                  {wf.steps.map((s, i) => (
                    <li key={i} className="pill border border-[var(--color-border)] px-2.5 py-0.5">
                      {i + 1}. {w.tools[s.capability] ?? s.capability}
                    </li>
                  ))}
                </ol>
                {confirmRemove === wf.id ? (
                  <div role="alertdialog" className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span>{fmt(w.removeConfirm, { name: wf.name })}</span>
                    <button type="button" onClick={() => void onRemove(wf)} disabled={busy === wf.id} className="btn-sky is-solid pill px-3 py-1.5 text-[12px]">
                      {busy === wf.id ? w.removing : w.remove}
                    </button>
                    <button type="button" onClick={() => setConfirmRemove(null)} className="btn-sky is-quiet pill px-3 py-1.5 text-[12px]">
                      {w.builder.cancel}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label={w.recentRuns} className="flex flex-col gap-2">
        <h2 className="m-0 text-[15px] font-semibold">{w.recentRuns}</h2>
        {runs.length === 0 ? (
          <p className="m-0 text-[13px] text-[var(--color-muted)]">{w.noRuns}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {runs.map((r) => (
              <li key={r.id}>
                <Link href={path(`/workflows/runs/${r.id}`)} className="panel press flex flex-wrap items-center justify-between gap-2 p-3 text-[13px]">
                  <span className="truncate font-medium">{r.workflow_name}</span>
                  <span className="text-[12px] tabular-nums text-[var(--color-muted)]">
                    {fmt(w.runSummary, {
                      status: (w.status as Record<string, string>)[r.status] ?? r.status,
                      charged: formatCredits(r.charged_credits, locale),
                      max: formatCredits(r.max_credits, locale),
                    })}{" "}
                    · {when(r.created_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
